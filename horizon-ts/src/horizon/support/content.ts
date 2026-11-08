/*
 * The text of Horizon's support, privacy and terms screens. The policies
 * stay in English only, on purpose: a translation could change what they
 * say. Paragraphs are lists of parts, so links can sit inside the text.
 */

export const POLICIES_UPDATED = '2026-11-08'
export const CONTACT_EMAIL = 'contact@mail.nearhorizon.app'

export type Part = string | {text: string; to: string}
export type Section = {heading?: string; paragraphs: Part[][]}

const email: Part = {text: CONTACT_EMAIL, to: `mailto:${CONTACT_EMAIL}`}

export const PRIVACY_SECTIONS: Section[] = [
  {
    paragraphs: [
      [
        'Welcome to Horizon. This policy explains our approach to your data when you use Horizon, an independent app for Bluesky. Horizon is not affiliated with Bluesky Social PBC.',
      ],
    ],
  },
  {
    heading: 'Your account and the network',
    paragraphs: [
      [
        'Horizon connects you to the Bluesky network through your Personal Data Server (PDS) and an AppView, which store and manage your account, posts and related data. Their terms and privacy policies govern that data. For reference, see ',
        {
          text: 'Bluesky’s privacy policy',
          to: 'https://bsky.social/about/support/privacy-policy',
        },
        '.',
      ],
    ],
  },
  {
    heading: 'Data stored on your device',
    paragraphs: [
      ['Horizon stores your session and settings on your own device to work.'],
    ],
  },
  {
    heading: 'Services we operate',
    paragraphs: [
      [
        'Some features, such as kryphocron posts, notifications and feedback, run on services we operate. We handle the information these features need to work, and keep it only as long as necessary. We may share it with service providers that help us run these features, or where required by law or to keep Horizon safe.',
      ],
    ],
  },
  {
    heading: 'Changes to this policy',
    paragraphs: [
      [
        'We may update this policy. If we do, we’ll update the date at the top of this page.',
      ],
    ],
  },
  {
    heading: 'Contact us',
    paragraphs: [['For questions about Horizon itself, email ', email, '.']],
  },
]

export const TERMS_SECTIONS: Section[] = [
  {
    paragraphs: [
      [
        'Welcome to Horizon! These terms govern your use of Horizon, an independent app for Bluesky. Horizon is not affiliated with Bluesky Social PBC. By using Horizon, you agree to these terms. Please also read our ',
        {text: 'privacy policy', to: '/about/support/privacy-policy'},
        '.',
      ],
    ],
  },
  {
    heading: 'Relationship to other services',
    paragraphs: [
      [
        'Horizon is a client. It lets you use the Bluesky network through your Personal Data Server (PDS) and an AppView. We don’t host your account or control those servers. Your use of them is governed by their own terms and policies. For reference, see ',
        {
          text: 'Bluesky’s terms of service',
          to: 'https://bsky.social/about/support/tos',
        },
        '.',
      ],
    ],
  },
  {
    heading: 'Services we operate',
    paragraphs: [
      [
        'Some features, such as kryphocron posts, notifications and feedback, run on services we operate. Don’t misuse them, or try to get around how they work. We may change or stop these features, or limit anyone’s access to them, at any time.',
      ],
    ],
  },
  {
    heading: 'Disclaimer of warranty',
    paragraphs: [
      [
        'Horizon is provided “AS IS” and “AS AVAILABLE”, without warranty of any kind, express or implied. We don’t warrant that it will be available, secure or error-free.',
      ],
    ],
  },
  {
    heading: 'Limitation of liability',
    paragraphs: [
      [
        'To the fullest extent permitted by law, we are not liable for any indirect, incidental, special, consequential or punitive damages, or any loss of data, profits or goodwill, resulting from your use of Horizon or the services it connects to. Our total liability shall not exceed zero U.S. dollars ($0.00).',
      ],
    ],
  },
  {
    heading: 'Changes to these terms',
    paragraphs: [
      [
        'We may revise these terms. By continuing to use Horizon after changes take effect, you agree to the revised terms.',
      ],
    ],
  },
  {
    heading: 'Contact',
    paragraphs: [['For questions about these terms, email ', email, '.']],
  },
]
