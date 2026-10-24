/*
 * Payment and support sites, by host (design.md 10.2: Horizon never builds a
 * preview of a payment link, because pages like PayPal's show the account's
 * legal name). The profile link editor asks `isPaymentUrl` before it sends a
 * link anywhere: a payment link gets no page title, no favicon and no
 * reachability check from cardyb.
 *
 * Unlike upstream's `getSupportProvider`, this matches the whole host, every
 * path and the bare homepage, so `paypal.com/donate/...`, `paypal.com/pools/...`
 * and a half-typed `paypal.com` all count. See
 * docs/internal/notes/upstream-profile-links-audit.md.
 */

import {
  SUPPORT_PROVIDERS,
  type SupportProvider,
  type SupportProviderLogoName,
} from '#/features/profileLinks/providers'

type PaymentDomain = {
  /** A registrable domain or a specific host; subdomains match too. */
  domain: string
  /** Only paths under this one count (`github.com/sponsors`). */
  pathPrefix?: string
  /** The bundled logo to draw in place of a favicon, if there is one. */
  logo?: SupportProviderLogoName
}

/**
 * Payment and support sites beyond upstream's list, or hosts upstream only
 * matches on some paths. Upstream's own providers are added below, by host.
 */
const HORIZON_PAYMENT_DOMAINS: PaymentDomain[] = [
  // design.md 10.2's allowed services
  {domain: 'paypal.com', logo: 'PayPal'},
  {domain: 'paypal.me', logo: 'PayPal'},
  {domain: 'cash.app', logo: 'CashApp'},
  {domain: 'cash.me', logo: 'CashApp'},
  {domain: 'venmo.com', logo: 'Venmo'},
  {domain: 'gofundme.com', logo: 'GoFundMe'},
  {domain: 'gofund.me', logo: 'GoFundMe'},
  {domain: 'ko-fi.com', logo: 'KoFi'},
  {domain: 'patreon.com', logo: 'Patreon'},
  {domain: 'throne.com', logo: 'Throne'},
  {domain: 'liberapay.com', logo: 'Liberapay'},
  {domain: 'buymeacoffee.com', logo: 'BuyMeACoffee'},
  {domain: 'buymeacoff.ee', logo: 'BuyMeACoffee'},
  {domain: 'opencollective.com', logo: 'OpenCollective'},
  {domain: 'givebutter.com', logo: 'Givebutter'},
  {domain: 'monzo.me'},
  {domain: 'revolut.me'},
  // other payment and fundraising sites
  {domain: 'github.com', pathPrefix: '/sponsors'},
  {domain: 'buy.stripe.com', logo: 'Stripe'},
  {domain: 'donate.stripe.com', logo: 'Stripe'},
  {domain: 'checkout.stripe.com', logo: 'Stripe'},
  {domain: 'gumroad.com', logo: 'Gumroad'},
  {domain: 'gum.co', logo: 'Gumroad'},
  {domain: 'wise.com'},
  {domain: 'zelle.com'},
  {domain: 'zellepay.com'},
  {domain: 'square.link'},
  {domain: 'tipeee.com'},
  {domain: 'streamlabs.com'},
  {domain: 'kickstarter.com', logo: 'Kickstarter'},
  {domain: 'indiegogo.com', logo: 'Indiegogo'},
]

/** Every payment host: Horizon's list, then upstream's providers by host. */
export const PAYMENT_DOMAINS: readonly PaymentDomain[] = [
  ...HORIZON_PAYMENT_DOMAINS,
  ...SUPPORT_PROVIDERS.map(provider => ({
    domain: provider.domain,
    logo: provider.logo,
  })),
]

/** True for the domain itself and its subdomains, never for lookalikes. */
function hostMatchesDomain(host: string, domain: string) {
  return host === domain || host.endsWith(`.${domain}`)
}

/**
 * PayPal's country sites (`paypal.de`, `paypal.co.uk`, `paypal.com.au`, and a
 * half-typed `paypal.co`): a `paypal` label followed by one TLD, or by
 * `co`/`com`/`net`/`org` and a country code.
 */
function isPayPalCountryHost(host: string) {
  return /(^|\.)paypal\.([a-z]{2,}|(co|com|net|org)\.[a-z]{2})$/.test(host)
}

function parseHost(url: string): {host: string; path: string} | undefined {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return undefined
    }
    return {
      host: parsed.hostname.toLowerCase().replace(/\.$/, ''),
      path: parsed.pathname.toLowerCase(),
    }
  } catch {
    return undefined
  }
}

function matchesEntry(host: string, path: string, entry: PaymentDomain) {
  if (!hostMatchesDomain(host, entry.domain)) return false
  if (!entry.pathPrefix) return true
  return path === entry.pathPrefix || path.startsWith(`${entry.pathPrefix}/`)
}

function findPaymentDomain(url: string | null | undefined) {
  if (!url) return undefined
  const parsed = parseHost(url)
  if (!parsed) return undefined
  const {host, path} = parsed
  if (isPayPalCountryHost(host)) return {domain: host, logo: 'PayPal' as const}
  return PAYMENT_DOMAINS.find(entry => matchesEntry(host, path, entry))
}

/**
 * True when the URL's host, or a parent domain, is a payment or support site.
 * Every path counts, the bare homepage included. Takes a full URL (the
 * editor's normalised `https://` one); anything unparsable is false.
 */
export function isPaymentUrl(url: string | null | undefined): boolean {
  return !!findPaymentDomain(url)
}

/**
 * A support provider whose bundled logo stands in for a favicon on a payment
 * link upstream does not recognise, like `paypal.com/donate/...`. Undefined
 * when no logo is bundled; the pill then shows its generic globe.
 */
export function paymentLogoProvider(
  url: string | null | undefined,
): SupportProvider | undefined {
  const logo = findPaymentDomain(url)?.logo
  if (!logo) return undefined
  return SUPPORT_PROVIDERS.find(provider => provider.logo === logo)
}

/**
 * How long the link editor waits after the last keystroke before asking
 * cardyb for a page title, so typing does not send every prefix.
 */
export const LINK_META_DEBOUNCE_MS = 500
