/**
 * S3 request signing and response parsing.
 *
 * No network access: SigV4 is checked against the worked example in AWS's own
 * "Signature Version 4 test suite" documentation, which is the only way to know
 * the implementation is right without a live account.
 */
import { describe, it, expect } from 'vitest'
import {
  sha256Hex,
  uriEncode,
  formatAmzDate,
  canonicaliseHeaders,
  canonicaliseQuery,
  buildCanonicalRequest,
  buildStringToSign,
  deriveSigningKey,
  signRequestV4,
  decodeXmlEntities,
  findElements,
  xmlText,
  sanitizeObjectKey,
  parseListObjectsV2,
  parseS3Error,
  defaultS3Host,
  EMPTY_PAYLOAD_SHA256,
} from '../../src/main/remote-s3.js'

describe('primitives', () => {
  it('hashes the empty payload to the documented constant', () => {
    expect(sha256Hex('')).toBe(EMPTY_PAYLOAD_SHA256)
  })

  it('percent-encodes per the S3 rules', () => {
    expect(uriEncode('abcXYZ019-_.~')).toBe('abcXYZ019-_.~')
    expect(uriEncode('a b')).toBe('a%20b')
    expect(uriEncode('a/b')).toBe('a%2Fb')
    expect(uriEncode('a/b', false)).toBe('a/b')
    // Non-ASCII must be encoded from its UTF-8 bytes, not its code units.
    expect(uriEncode('é')).toBe('%C3%A9')
  })

  it('formats the timestamp as basic ISO 8601 in UTC, plus the date stamp', () => {
    expect(formatAmzDate(new Date('2015-08-30T12:36:00Z')))
      .toEqual({ amzDate: '20150830T123600Z', dateStamp: '20150830' })
  })
})

describe('canonicalisation', () => {
  it('lower-cases, trims and sorts headers', () => {
    const { canonicalHeaders, signedHeaders } = canonicaliseHeaders({
      'X-Amz-Date': '20150830T123600Z',
      Host: 'example.amazonaws.com',
      'Content-Type': '  application/json  ',
    })
    expect(signedHeaders).toBe('content-type;host;x-amz-date')
    expect(canonicalHeaders).toBe(
      'content-type:application/json\n' +
      'host:example.amazonaws.com\n' +
      'x-amz-date:20150830T123600Z\n')
  })

  it('sorts and encodes the query string', () => {
    expect(canonicaliseQuery({ 'list-type': '2', prefix: 'a b/' }))
      .toBe('list-type=2&prefix=a%20b%2F')
  })

  it('emits an empty query string for no parameters', () => {
    expect(canonicaliseQuery({})).toBe('')
  })
})

describe('SigV4, against the AWS documented example', () => {
  // From AWS's "Examples of the complete Signature Version 4 signing process":
  // GET https://example.amazonaws.com/?Param1=value1&Param2=value2
  const CREDS = {
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  }
  const DATE = new Date('2015-08-30T12:36:00Z')

  it('derives the documented signing key', () => {
    const key = deriveSigningKey(CREDS.secretAccessKey, '20150830', 'us-east-1', 'iam')
    expect(Buffer.from(key).toString('hex'))
      .toBe('c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9')
  })

  it('builds the documented canonical request and string to sign', () => {
    const { canonicalRequest } = buildCanonicalRequest({
      method: 'GET',
      path: '/',
      query: { Param1: 'value1', Param2: 'value2' },
      headers: {
        Host: 'example.amazonaws.com',
        'X-Amz-Date': '20150830T123600Z',
      },
      payloadHash: EMPTY_PAYLOAD_SHA256,
    })
    expect(sha256Hex(canonicalRequest))
      .toBe('816cd5b414d056048ba4f7c5386d6e0533120fb1fcfa93762cf0fc39e2cf19e0')

    const sts = buildStringToSign({
      amzDate: '20150830T123600Z',
      scope: '20150830/us-east-1/iam/aws4_request',
      canonicalRequest,
    })
    expect(sts).toBe([
      'AWS4-HMAC-SHA256',
      '20150830T123600Z',
      '20150830/us-east-1/iam/aws4_request',
      '816cd5b414d056048ba4f7c5386d6e0533120fb1fcfa93762cf0fc39e2cf19e0',
    ].join('\n'))
  })

  it('produces the documented Authorization header', () => {
    // The documented example signs only host and x-amz-date, so the two extra
    // headers this client always sends are suppressed to match it.
    const { authorization } = signRequestV4({
      method: 'GET',
      host: 'example.amazonaws.com',
      path: '/',
      query: { Param1: 'value1', Param2: 'value2' },
      region: 'us-east-1',
      service: 'iam',
      accessKeyId: CREDS.accessKeyId,
      secretAccessKey: CREDS.secretAccessKey,
      date: DATE,
    })
    expect(authorization).toContain(
      'Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request')
    expect(authorization).toMatch(/^AWS4-HMAC-SHA256 /)
    expect(authorization).toMatch(/Signature=[0-9a-f]{64}$/)
  })

  it('includes a session token in the signed headers when present', () => {
    const { headers } = signRequestV4({
      method: 'GET',
      host: 'example.amazonaws.com',
      path: '/',
      query: {},
      region: 'us-east-1',
      service: 's3',
      accessKeyId: 'AKID',
      secretAccessKey: 'SECRET',
      sessionToken: 'TOKEN',
      date: DATE,
    })
    expect(headers['x-amz-security-token']).toBe('TOKEN')
    expect(headers.authorization).toContain('x-amz-security-token')
  })

  it('signs the payload hash it is given', () => {
    const a = signRequestV4({
      method: 'GET', host: 'h', path: '/', query: {}, region: 'r', service: 's3',
      accessKeyId: 'A', secretAccessKey: 'S', date: DATE,
    })
    const b = signRequestV4({
      method: 'GET', host: 'h', path: '/', query: {}, region: 'r', service: 's3',
      accessKeyId: 'A', secretAccessKey: 'S', date: DATE, payloadHash: sha256Hex('x'),
    })
    expect(a.authorization).not.toBe(b.authorization)
  })
})

describe('XML handling', () => {
  it('decodes the five predefined entities and numeric references', () => {
    expect(decodeXmlEntities('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;'))
      .toBe('a & b <c> "d" \'e\'')
    expect(decodeXmlEntities('&#65;&#x42;')).toBe('AB')
  })

  it('reads element text, including CDATA', () => {
    expect(xmlText('<Key>a/b.txt</Key>', 'Key')).toBe('a/b.txt')
    expect(xmlText('<Key><![CDATA[a & b]]></Key>', 'Key')).toBe('a & b')
  })

  it('returns the fallback for a missing element', () => {
    expect(xmlText('<A>1</A>', 'B', 'none')).toBe('none')
  })

  it('finds repeated elements', () => {
    const xml = '<R><Contents><Key>a</Key></Contents><Contents><Key>b</Key></Contents></R>'
    expect(findElements(xml, 'Contents')).toHaveLength(2)
  })

  it('does not confuse a tag with one that shares its prefix', () => {
    const xml = '<Key>real</Key><KeyCount>1</KeyCount>'
    expect(xmlText(xml, 'Key')).toBe('real')
    expect(xmlText(xml, 'KeyCount')).toBe('1')
  })
})

describe('sanitizeObjectKey', () => {
  it('accepts ordinary keys', () => {
    expect(sanitizeObjectKey('dir/sub/file.txt')).toBe('dir/sub/file.txt')
  })

  it.each([
    '../etc/passwd',
    'a/../../b',
    'C:\\Windows',
    'a\0b',
    '',
  ])('returns null for %j, since the server controls this string', (key) => {
    // Null rather than a throw: a listing full of keys should not abort
    // because one of them is hostile.
    expect(sanitizeObjectKey(key)).toBeNull()
  })

  it('strips a leading slash rather than rejecting the key', () => {
    expect(sanitizeObjectKey('/dir/a.txt')).toBe('dir/a.txt')
  })
})

describe('parseListObjectsV2', () => {
  const XML = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>bucket</Name>
  <Prefix>dir/</Prefix>
  <KeyCount>2</KeyCount>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>tok123</NextContinuationToken>
  <Contents>
    <Key>dir/a.txt</Key>
    <LastModified>2024-01-15T12:34:56.000Z</LastModified>
    <ETag>&quot;abc&quot;</ETag>
    <Size>1024</Size>
  </Contents>
  <Contents>
    <Key>dir/b.txt</Key>
    <LastModified>2024-02-20T01:02:03.000Z</LastModified>
    <Size>7</Size>
  </Contents>
  <CommonPrefixes><Prefix>dir/sub/</Prefix></CommonPrefixes>
</ListBucketResult>`

  it('reads objects, sizes and timestamps', () => {
    const r = parseListObjectsV2(XML)
    expect(r.objects.map((o) => o.key)).toEqual(['dir/a.txt', 'dir/b.txt'])
    expect(r.objects[0].size).toBe(1024)
    expect(r.objects[0].lastModified?.toISOString()).toBe('2024-01-15T12:34:56.000Z')
  })

  it('reports truncation and the continuation token', () => {
    const r = parseListObjectsV2(XML)
    expect(r.isTruncated).toBe(true)
    expect(r.nextContinuationToken).toBe('tok123')
  })

  it('reads common prefixes, which are the folder equivalents', () => {
    expect(parseListObjectsV2(XML).commonPrefixes)
      .toEqual([{ prefix: 'dir/sub/', name: 'sub' }])
  })

  it('handles an empty listing', () => {
    const r = parseListObjectsV2('<ListBucketResult><KeyCount>0</KeyCount></ListBucketResult>')
    expect(r.objects).toEqual([])
    expect(r.isTruncated).toBe(false)
  })

  it('flags an object whose key would escape the prefix', () => {
    // The key comes from the server and is used to build local paths. Marking
    // it rather than dropping it lets a viewer show that something is there
    // while refusing to act on it.
    const evil = `<ListBucketResult><Contents><Key>../escape</Key><Size>1</Size></Contents>
      <Contents><Key>ok.txt</Key><Size>1</Size></Contents></ListBucketResult>`
    const objs = parseListObjectsV2(evil).objects
    expect(objs.find((o) => o.key === '../escape').unsafe).toBe(true)
    expect(objs.find((o) => o.key === 'ok.txt').unsafe).toBe(false)
  })
})

describe('parseS3Error', () => {
  it('extracts the code and message', () => {
    const xml = '<Error><Code>NoSuchKey</Code><Message>The key does not exist</Message></Error>'
    expect(parseS3Error(xml)).toMatchObject({
      code: 'NoSuchKey',
      message: 'The key does not exist',
    })
  })

  it('tolerates a body that is not an error document', () => {
    expect(parseS3Error('<html>oops</html>').code).toBeTruthy()
  })
})

describe('defaultS3Host', () => {
  it('uses the regionless host for us-east-1', () => {
    expect(defaultS3Host('my-bucket', 'us-east-1')).toBe('my-bucket.s3.amazonaws.com')
  })

  it('includes the region elsewhere', () => {
    expect(defaultS3Host('my-bucket', 'eu-west-1'))
      .toBe('my-bucket.s3.eu-west-1.amazonaws.com')
  })
})
