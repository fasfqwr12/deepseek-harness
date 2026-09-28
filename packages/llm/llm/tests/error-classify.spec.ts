import { describe, expect, it } from 'vitest'
import { isFarFutureRateLimitReset, RATE_LIMIT_QUOTA_HORIZON_MS } from '../src/error.ts'

/** 2099-01-01T00:00:00Z in milliseconds, far beyond any test clock drift. */
const FAR = Date.parse('2099-01-01T00:00:00Z')
/** A clock just before a near-horizon reset, so the comparison is exact. */
const NEAR = FAR - RATE_LIMIT_QUOTA_HORIZON_MS - 60_000

describe('isFarFutureRateLimitReset', () => {
  it('treats a Chinese gateway reset timestamp beyond the horizon as a quota wall', () => {
    const message = '您的使用量已超出频率限制，将在 2099-01-01 08:00:00 UTC+8 重置'
    // 08:00 UTC+8 is 00:00 UTC.
    expect(isFarFutureRateLimitReset(message, NEAR)).toBe(true)
  })

  it('treats a reset horizon inside the threshold as transient', () => {
    const message = '您的使用量已超出频率限制，将在 2099-01-01 07:59:00 UTC+8 重置'
    expect(isFarFutureRateLimitReset(message, NEAR)).toBe(false)
  })

  it('accepts an explicit timezone offset in the message text', () => {
    // 2099-01-01 08:00:00 UTC+8 == 2099-01-01T00:00:00Z == exactly FAR, so the
    // horizon is FAR - NEAR = 120s > 60s. The offset must be applied, not
    // ignored: treating the local clock as UTC would land 8 hours EARLIER.
    expect(isFarFutureRateLimitReset('429: rate limited, resets 2099-01-01 08:00:00 UTC+8', NEAR)).toBe(true)
    expect(isFarFutureRateLimitReset('rate limited; window resets 2099-01-01 00:00:00', NEAR)).toBe(true)
  })

  it('parses English relative horizons', () => {
    expect(isFarFutureRateLimitReset('rate limit reached, resets in 5 minutes', NEAR)).toBe(true)
    expect(isFarFutureRateLimitReset('rate limit reached, resets in 30 seconds', NEAR)).toBe(false)
    expect(isFarFutureRateLimitReset('quota window resets in 2 hours', NEAR)).toBe(true)
  })

  it('parses Chinese relative horizons', () => {
    expect(isFarFutureRateLimitReset('请求过于频繁，2小时后重置', NEAR)).toBe(true)
    expect(isFarFutureRateLimitReset('请求过于频繁，30秒后重置', NEAR)).toBe(false)
  })

  it('returns false when no reset wording is present', () => {
    expect(isFarFutureRateLimitReset('429: router in-flight request budget reached', NEAR)).toBe(false)
    expect(isFarFutureRateLimitReset('', NEAR)).toBe(false)
  })

  it('ignores an unparseable absolute timestamp', () => {
    expect(isFarFutureRateLimitReset('will reset 2099-13-99 99:99', NEAR)).toBe(false)
  })
})
