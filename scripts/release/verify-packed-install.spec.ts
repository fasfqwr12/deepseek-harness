/** Packed-install command policy. */

import { describe, expect, it } from 'vitest'
import { npmInvocation, packedInstallArguments } from './verify-packed-install.ts'

describe('packed install arguments', () => {
  it('keeps platform-selected optional dependencies enabled', () => {
    expect(packedInstallArguments()).toEqual([
      'install',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
    ])
    expect(packedInstallArguments()).not.toContain('--omit=optional')
  })

  it('runs npm through Node rather than a Windows command shim', () => {
    expect(npmInvocation(['install'], 'win32', 'C:\\Node\\node.exe')).toEqual([
      'C:\\Node\\node.exe',
      ['C:\\Node\\node_modules\\npm\\bin\\npm-cli.js', 'install'],
    ])
    expect(npmInvocation(['install'], 'linux', '/usr/bin/node')).toEqual(['npm', ['install']])
  })
})
