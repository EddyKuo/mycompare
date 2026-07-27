"""
A throwaway SFTP server for interop testing.

Nothing in the app depends on this. It exists so the SSH transport can be
tested against a real implementation rather than against our own encoder --
the failure mode of a hand-written crypto protocol is agreeing with itself.

Requires paramiko (a test-only tool, not a project dependency):
    python -m pip install paramiko

Usage:
    python tests/helpers/sftp-server.py <root-dir> [port]

Prints one JSON line to stdout once it is listening:
    {"port": 2222, "hostKeyFingerprint": "SHA256:...", "user": "...", "password": "..."}
"""

import base64
import hashlib
import json
import os
import socket
import sys
import threading

import paramiko

USER = "testuser"
PASSWORD = "testpass"


class Server(paramiko.ServerInterface):
    def check_auth_password(self, username, password):
        if username == USER and password == PASSWORD:
            return paramiko.AUTH_SUCCESSFUL
        return paramiko.AUTH_FAILED

    def get_allowed_auths(self, username):
        return "password"

    def check_channel_request(self, kind, chanid):
        if kind == "session":
            return paramiko.OPEN_SUCCEEDED
        return paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED


class StubSFTPHandle(paramiko.SFTPHandle):
    def stat(self):
        try:
            return paramiko.SFTPAttributes.from_stat(os.fstat(self.readfile.fileno()))
        except OSError as exc:
            return paramiko.SFTPServer.convert_errno(exc.errno)


class StubSFTPServer(paramiko.SFTPServerInterface):
    ROOT = "."

    def _realpath(self, path):
        # Confine everything to ROOT: the client is under test, so it may well
        # send something hostile.
        joined = os.path.normpath(os.path.join(self.ROOT, path.lstrip("/")))
        root = os.path.normpath(self.ROOT)
        if not os.path.abspath(joined).startswith(os.path.abspath(root)):
            return root
        return joined

    def list_folder(self, path):
        p = self._realpath(path)
        try:
            out = []
            for name in os.listdir(p):
                attr = paramiko.SFTPAttributes.from_stat(os.stat(os.path.join(p, name)))
                attr.filename = name
                out.append(attr)
            return out
        except OSError as exc:
            return paramiko.SFTPServer.convert_errno(exc.errno)

    def stat(self, path):
        try:
            return paramiko.SFTPAttributes.from_stat(os.stat(self._realpath(path)))
        except OSError as exc:
            return paramiko.SFTPServer.convert_errno(exc.errno)

    lstat = stat

    def open(self, path, flags, attr):
        p = self._realpath(path)
        try:
            fd = os.open(p, flags if flags else os.O_RDONLY)
        except OSError as exc:
            return paramiko.SFTPServer.convert_errno(exc.errno)
        handle = StubSFTPHandle(flags)
        handle.filename = p
        handle.readfile = os.fdopen(fd, "rb")
        return handle

    def canonicalize(self, path):
        rel = os.path.relpath(self._realpath(path), self.ROOT).replace("\\", "/")
        return "/" if rel == "." else "/" + rel


def load_or_create_host_key(path):
    # paramiko has no ed25519 key generator, so shell out to ssh-keygen. The key
    # type matters: the client under test verifies ssh-ed25519 signatures, and an
    # RSA fallback would quietly skip the code path we most want exercised.
    if not os.path.exists(path):
        import subprocess
        subprocess.run(
            ["ssh-keygen", "-t", "ed25519", "-N", "", "-q", "-f", path],
            check=True,
        )
    return paramiko.Ed25519Key(filename=path)


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 0

    StubSFTPServer.ROOT = root
    # Kept outside the served root so it does not turn up in directory listings
    # that tests assert on.
    key = load_or_create_host_key(
        os.path.join(os.path.dirname(os.path.abspath(root)), "_hostkey_ed25519"))

    blob = key.asbytes()
    fingerprint = "SHA256:" + base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip("=")

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", port))
    sock.listen(8)
    actual_port = sock.getsockname()[1]

    print(json.dumps({
        "port": actual_port,
        "hostKeyFingerprint": fingerprint,
        "hostKeyType": key.get_name(),
        "user": USER,
        "password": PASSWORD,
    }), flush=True)

    def serve(conn):
        try:
            t = paramiko.Transport(conn)
            t.add_server_key(key)
            t.set_subsystem_handler("sftp", paramiko.SFTPServer, StubSFTPServer)
            t.start_server(server=Server())
            chan = t.accept(20)
            if chan is not None:
                while t.is_active():
                    t.join(1)
        except Exception:
            pass
        finally:
            try:
                conn.close()
            except Exception:
                pass

    while True:
        try:
            conn, _ = sock.accept()
        except OSError:
            break
        threading.Thread(target=serve, args=(conn,), daemon=True).start()


if __name__ == "__main__":
    main()
