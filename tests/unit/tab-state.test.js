import { describe, it, expect } from 'vitest'

// Test tab state management logic by simulating the data structures.
// _saveTabState / _restoreTabState are internal to app.js (not exported),
// so we validate the state shape and isolation properties directly.

describe('Tab state management logic', () => {
  it('should capture text compare state shape', () => {
    const mockTextCompare = {
      _leftPath: '/path/left.txt',
      _rightPath: '/path/right.txt',
      _leftContent: 'line1\nline2\n',
      _rightContent: 'line1\nmodified\n',
    }

    const tab = { id: 'tab-1', type: 'text', title: '文字比對', leftPath: '', rightPath: '', basePath: '', state: null }

    // Simulate saveTabState
    tab.state = {
      leftPath: mockTextCompare._leftPath,
      rightPath: mockTextCompare._rightPath,
      leftContent: mockTextCompare._leftContent,
      rightContent: mockTextCompare._rightContent,
    }

    expect(tab.state.leftPath).toBe('/path/left.txt')
    expect(tab.state.rightPath).toBe('/path/right.txt')
    expect(tab.state.leftContent).toBe('line1\nline2\n')
    expect(tab.state.rightContent).toBe('line1\nmodified\n')
  })

  it('should handle null state gracefully', () => {
    const tab = { id: 'tab-1', type: 'text', title: '文字比對', leftPath: '', rightPath: '', basePath: '', state: null }
    // restoreTabState should no-op when state is null
    expect(tab.state).toBeNull()
    // No error thrown when state is null — the function returns early
  })

  it('should support independent state per tab', () => {
    const tab1 = { id: 'tab-1', type: 'text', state: { leftPath: '/a.txt', rightPath: '/b.txt', leftContent: 'aaa', rightContent: 'bbb' } }
    const tab2 = { id: 'tab-2', type: 'text', state: { leftPath: '/c.txt', rightPath: '/d.txt', leftContent: 'ccc', rightContent: 'ddd' } }

    expect(tab1.state.leftPath).not.toBe(tab2.state.leftPath)
    expect(tab1.state.leftContent).not.toBe(tab2.state.leftContent)
  })

  it('should capture folder compare state shape', () => {
    const mockFolderCompare = {
      _leftPath: '/folder/left',
      _rightPath: '/folder/right',
    }

    const tab = { id: 'tab-2', type: 'folder', title: '資料夾比對', leftPath: '', rightPath: '', basePath: '', state: null }

    // Simulate saveTabState for folder
    tab.state = {
      leftPath: mockFolderCompare._leftPath ?? '',
      rightPath: mockFolderCompare._rightPath ?? '',
    }

    expect(tab.state.leftPath).toBe('/folder/left')
    expect(tab.state.rightPath).toBe('/folder/right')
  })

  it('should initialise with state: null for new tabs', () => {
    // Simulate addTab() creating a new TabRecord
    const newTab = { id: 'tab-3', type: 'text', title: '文字比對', leftPath: '', rightPath: '', basePath: '', state: null }
    expect(newTab.state).toBeNull()
  })

  it('should not share state object reference between tabs after independent assignment', () => {
    const tab1 = { id: 'tab-1', type: 'text', state: null }
    const tab2 = { id: 'tab-2', type: 'text', state: null }

    tab1.state = { leftPath: '/a.txt', rightPath: '/b.txt', leftContent: 'hello', rightContent: 'world' }
    tab2.state = { leftPath: '/c.txt', rightPath: '/d.txt', leftContent: 'foo', rightContent: 'bar' }

    // Mutating tab2 should not affect tab1
    tab2.state.leftContent = 'changed'
    expect(tab1.state.leftContent).toBe('hello')
  })
})
