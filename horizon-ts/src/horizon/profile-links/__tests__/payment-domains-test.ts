import {describe, expect, it} from '@jest/globals'

import {SUPPORT_PROVIDERS} from '#/features/profileLinks/providers'
import {
  isPaymentUrl,
  paymentLogoProvider,
} from '#/horizon/profile-links/payment-domains'

describe('isPaymentUrl', () => {
  it.each([
    // PayPal, every path and the bare hosts
    'https://paypal.com',
    'https://paypal.com/',
    'https://www.paypal.com/donate/?hosted_button_id=ABC123',
    'https://www.paypal.com/pools/c/abc',
    'https://www.paypal.com/ncp/payment/XYZ',
    'https://paypal.com/paypalme/name',
    'https://paypal.me',
    'https://paypal.me/name',
    'https://PAYPAL.ME/Name',
    'https://paypal.com./donate',
    'https://www.paypal.de/donate',
    'https://www.paypal.co.uk/x',
    'https://paypal.com.au/x',
    'https://paypal.co',
    // design.md 10.2's thirteen allowed services
    'https://cash.app/$tag',
    'https://venmo.com/u/name',
    'https://gofundme.com/f/slug',
    'https://ko-fi.com/name',
    'https://patreon.com/name',
    'https://throne.com/name',
    'https://liberapay.com/name',
    'https://buymeacoffee.com/name',
    'https://opencollective.com/slug',
    'https://givebutter.com/slug',
    'https://monzo.me/name',
    'https://revolut.me/name',
    // the rest of Horizon's list
    'https://cash.me/$tag',
    'https://github.com/sponsors',
    'https://github.com/sponsors/someone',
    'https://buy.stripe.com/abc',
    'https://donate.stripe.com/abc',
    'https://gumroad.com/l/x',
    'https://name.gumroad.com',
    'https://wise.com/pay/me/name',
    'https://zelle.com',
    'https://www.zellepay.com',
    'https://square.link/u/abc',
    'https://en.tipeee.com/name',
    'https://streamlabs.com/name/tip',
    'https://www.kickstarter.com/projects/x/y',
    'https://www.indiegogo.com/projects/x',
    // hosts only, no path
    'https://ko-fi.com',
    'https://venmo.com',
  ])('true for %s', url => {
    expect(isPaymentUrl(url)).toBe(true)
  })

  it('covers every support site upstream recognises, by host and path', () => {
    for (const provider of SUPPORT_PROVIDERS) {
      const prefix = (provider.pathPrefix ?? '').replace(/\/+$/, '')
      expect(isPaymentUrl(`https://${provider.domain}${prefix}`)).toBe(true)
      expect(
        isPaymentUrl(`https://sub.${provider.domain}${prefix}/any/path`),
      ).toBe(true)
    }
  })

  it.each([
    'https://notpaypal.com',
    'https://paypal.com.example.net/x',
    'https://paypal.example.com',
    'https://mypaypal.me',
    'https://ko-fi.com.example.net/name',
    'https://notko-fi.com',
    'https://github.com',
    'https://github.com/someone',
    'https://github.com/sponsorship',
    'https://stripe.com',
    'https://cash.apple.com',
    'https://example.com/paypal.com',
    'https://example.com/?u=paypal.me',
    'https://bsky.app',
  ])('false for %s', url => {
    expect(isPaymentUrl(url)).toBe(false)
  })

  it('is false for nothing or an unparsable URL', () => {
    expect(isPaymentUrl(null)).toBe(false)
    expect(isPaymentUrl(undefined)).toBe(false)
    expect(isPaymentUrl('')).toBe(false)
    expect(isPaymentUrl('paypal.com')).toBe(false)
    expect(isPaymentUrl('ftp://paypal.com')).toBe(false)
  })
})

describe('paymentLogoProvider', () => {
  it('gives the bundled logo for an unrecognised payment link', () => {
    expect(
      paymentLogoProvider('https://www.paypal.com/donate/?x=1')?.logo,
    ).toBe('PayPal')
    expect(paymentLogoProvider('https://paypal.de')?.logo).toBe('PayPal')
    expect(paymentLogoProvider('https://cash.me/$x')?.logo).toBe('CashApp')
  })

  it('is undefined when nothing is bundled, or for other sites', () => {
    expect(paymentLogoProvider('https://github.com/sponsors/x')).toBeUndefined()
    expect(paymentLogoProvider('https://monzo.me/x')).toBeUndefined()
    expect(paymentLogoProvider('https://example.com')).toBeUndefined()
  })
})
