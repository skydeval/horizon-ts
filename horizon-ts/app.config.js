// @ts-check
// HORIZON: the product name has one source in src/horizon/branding
const product = require('./src/horizon/branding/product.json')

/**
 * @param {import('@expo/config-types').ExpoConfig} _config
 * @returns {{ expo: import('@expo/config-types').ExpoConfig }}
 */
module.exports = function (_config) {
  /**
   * App version number. Should be incremented as part of a release cycle.
   *
   * HORIZON: Horizon's own version, beside its name in src/horizon/branding;
   * package.json keeps upstream's, so merges stay clean
   */
  const VERSION = product.version

  /**
   * HORIZON: Android's build number, which must rise with every release so an
   * installed copy accepts the next one. The release build sets it
   */
  const ANDROID_VERSION_CODE = Number(process.env.HORIZON_VERSION_CODE) || 1

  /**
   * Uses built-in Expo env vars
   *
   * @see https://docs.expo.dev/build-reference/variables/#built-in-environment-variables
   */
  const PLATFORM = process.env.EAS_BUILD_PLATFORM ?? 'web'

  const IS_TESTFLIGHT = process.env.EXPO_PUBLIC_ENV === 'testflight'
  const IS_PRODUCTION = process.env.EXPO_PUBLIC_ENV === 'production'
  const IS_E2E = process.env.EXPO_PUBLIC_ENV === 'e2e'
  const IS_DEV = !IS_TESTFLIGHT && !IS_PRODUCTION

  const ASSOCIATED_DOMAINS = [
    'applinks:bsky.app',
    'applinks:staging.bsky.app',
    'appclips:bsky.app',
    'appclips:go.bsky.app', // Allows App Clip to work when scanning QR codes
    // When testing local services, enter an ngrok (et al) domain here. It must use a standard HTTP/HTTPS port.
    ...(IS_DEV || IS_TESTFLIGHT ? [] : []),
  ]

  /*
   * EXPO_PUBLIC_ENV is also an EAS environment secret, which wins over a build
   * profile's env, so profiles opt out of OTA updates with their own flag. A
   * dev client with updates on rejects unsigned manifests from a local Metro.
   */
  /*
   * HORIZON: over-the-air updates are off. Upstream's channel is Bluesky's
   * server and signing certificate, so a Horizon build that checked it could
   * replace itself with stock Bluesky. A Horizon update server can switch this
   * back on with its own URL and certificate
   */
  const UPDATES_ENABLED = false

  const USE_SENTRY = Boolean(process.env.SENTRY_AUTH_TOKEN)

  const IOS_ICON_FILE =
    PLATFORM === 'web' // web build doesn't like .icon files
      ? './assets/app-icons/ios_icon_default_next.png'
      : IS_TESTFLIGHT
        ? './assets/app-icons/ios_icon_testflight.icon'
        : './assets/app-icons/ios_icon_default.icon'

  return {
    expo: {
      version: VERSION,
      // HORIZON: the product name has one source in src/horizon/branding
      name: product.name,
      /*
       * HORIZON: Horizon's own identity. The scheme is the reverse of
       * nearhorizon.app, which native OAuth needs for its redirect
       */
      slug: 'horizon',
      scheme: 'app.nearhorizon',
      runtimeVersion: {
        policy: 'appVersion',
      },
      icon: './assets/app-icons/ios_icon_default_next.png',
      userInterfaceStyle: 'automatic',
      primaryColor: '#006AFF',
      ios: {
        supportsTablet: true,
        bundleIdentifier: 'xyz.blueskyweb.app',
        appleTeamId: process.env.EXPO_APPLE_TEAM_ID,
        config: {
          usesNonExemptEncryption: false,
        },
        icon: IOS_ICON_FILE,
        infoPlist: {
          UISupportedInterfaceOrientations: ['UIInterfaceOrientationPortrait'],
          'UISupportedInterfaceOrientations~ipad': [
            'UIInterfaceOrientationPortrait',
            'UIInterfaceOrientationPortraitUpsideDown',
            'UIInterfaceOrientationLandscapeLeft',
            'UIInterfaceOrientationLandscapeRight',
          ],
          CADisableMinimumFrameDurationOnPhone: true,
          UIBackgroundModes: ['remote-notification'],
          NSUserActivityTypes: ['INSendMessageIntent'],
          NSCameraUsageDescription:
            'Used for profile pictures, posts, and other kinds of content.',
          NSMicrophoneUsageDescription:
            'Used for posts and other kinds of content.',
          NSPhotoLibraryAddUsageDescription:
            'Used to save images to your library.',
          NSPhotoLibraryUsageDescription:
            'Used for profile pictures, posts, and other kinds of content',
          CFBundleSpokenName: 'Blue Sky',
          CFBundleLocalizations: [
            'en',
            'an',
            'ast',
            'ca',
            'cs',
            'cy',
            'da',
            'de',
            'el',
            'eo',
            'es',
            'eu',
            'fi',
            'fr',
            'fy',
            'ga',
            'gd',
            'gl',
            'hi',
            'hu',
            'ia',
            'id',
            'it',
            'ja',
            'km',
            'ko',
            'ne',
            'nl',
            'pl',
            'pt-BR',
            'pt-PT',
            'ro',
            'ru',
            'sv',
            'th',
            'tr',
            'uk',
            'vi',
            'yue',
            'zh-Hans',
            'zh-Hant',
          ],
        },
        associatedDomains: ASSOCIATED_DOMAINS,
        entitlements: {
          'com.apple.developer.kernel.increased-memory-limit': true,
          'com.apple.developer.kernel.extended-virtual-addressing': true,
          'com.apple.security.application-groups': 'group.app.bsky',
          'com.apple.developer.usernotifications.communication': true,
          // 'com.apple.developer.device-information.user-assigned-device-name': true,
          'com.apple.developer.declared-age-range': true,
        },
        privacyManifests: {
          NSPrivacyCollectedDataTypes: [
            {
              NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeCrashData',
              NSPrivacyCollectedDataTypeLinked: false,
              NSPrivacyCollectedDataTypeTracking: false,
              NSPrivacyCollectedDataTypePurposes: [
                'NSPrivacyCollectedDataTypePurposeAppFunctionality',
              ],
            },
            {
              NSPrivacyCollectedDataType:
                'NSPrivacyCollectedDataTypePerformanceData',
              NSPrivacyCollectedDataTypeLinked: false,
              NSPrivacyCollectedDataTypeTracking: false,
              NSPrivacyCollectedDataTypePurposes: [
                'NSPrivacyCollectedDataTypePurposeAppFunctionality',
              ],
            },
            {
              NSPrivacyCollectedDataType:
                'NSPrivacyCollectedDataTypeOtherDiagnosticData',
              NSPrivacyCollectedDataTypeLinked: false,
              NSPrivacyCollectedDataTypeTracking: false,
              NSPrivacyCollectedDataTypePurposes: [
                'NSPrivacyCollectedDataTypePurposeAppFunctionality',
              ],
            },
          ],
          NSPrivacyAccessedAPITypes: [
            {
              NSPrivacyAccessedAPIType:
                'NSPrivacyAccessedAPICategoryFileTimestamp',
              NSPrivacyAccessedAPITypeReasons: ['C617.1', '3B52.1', '0A2A.1'],
            },
            {
              NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace',
              NSPrivacyAccessedAPITypeReasons: ['E174.1', '85F4.1'],
            },
            {
              NSPrivacyAccessedAPIType:
                'NSPrivacyAccessedAPICategorySystemBootTime',
              NSPrivacyAccessedAPITypeReasons: ['35F9.1'],
            },
            {
              NSPrivacyAccessedAPIType:
                'NSPrivacyAccessedAPICategoryUserDefaults',
              NSPrivacyAccessedAPITypeReasons: ['CA92.1', '1C8F.1'],
            },
          ],
        },
      },
      android: {
        // HORIZON: Horizon's own mark (assets/horizon), not Bluesky's butterfly
        icon: './assets/horizon/android-icon.png',
        adaptiveIcon: {
          foregroundImage: './assets/horizon/android-foreground.png',
          monochromeImage: './assets/horizon/android-monochrome.png',
          // The mark's sky
          backgroundColor: '#CFE5EE',
        },
        googleServicesFile: './google-services.json',
        // HORIZON: Horizon's own package, so it installs beside Bluesky
        package: 'app.nearhorizon',
        versionCode: ANDROID_VERSION_CODE,
        intentFilters: [
          {
            action: 'VIEW',
            autoVerify: true,
            data: [
              {
                scheme: 'https',
                // HORIZON: Horizon's links, not bsky.app's
                host: 'nearhorizon.app',
              },
              ...(IS_DEV
                ? [
                    {
                      scheme: 'http',
                      host: 'localhost:19006',
                    },
                  ]
                : []),
            ],
            category: ['BROWSABLE', 'DEFAULT'],
          },
        ],
      },
      web: {
        bundler: 'metro',
        favicon: './assets/favicon.png',
      },
      updates: {
        // HORIZON: no update server (see UPDATES_ENABLED)
        enabled: UPDATES_ENABLED,
        fallbackToCacheTimeout: 30000,
        codeSigningCertificate: UPDATES_ENABLED
          ? './code-signing/certificate.pem'
          : undefined,
        codeSigningMetadata: UPDATES_ENABLED
          ? {
              keyid: 'main',
              alg: 'rsa-v1_5-sha256',
            }
          : undefined,
        checkAutomatically: 'NEVER',
      },
      plugins: [
        [
          'expo-dev-client',
          {
            toolsButton: false,
            ...(IS_E2E
              ? {
                  launchMode: 'most-recent',
                  skipOnboarding: true,
                  showMenuAtLaunch: false,
                  ios: {
                    defaultLaunchURL: 'http://localhost:8081',
                  },
                  android: {
                    defaultLaunchURL: 'http://10.0.2.2:8081',
                  },
                }
              : {}),
          },
        ],
        'expo-asset',
        'expo-sharing',
        'expo-video',
        [
          'expo-localization',
          {
            /*
             * React Native 0.88 fixed Android RTL detection, which until then
             * always reported LTR. Opt out so Android keeps rendering LTR like
             * iOS, until RTL layouts get a proper QA pass.
             */
            supportsRTL: false,
          },
        ],
        'expo-web-browser',
        [
          'react-native-nano-icons',
          {
            /*
             * One font per codegen directory under `assets/icons/`, see
             * `scripts/icons/README.md`.
             */
            iconSets: ['ui', 'brands', 'community'].map(lane => ({
              inputDir: `./assets/icons/${lane}`,
              outputDir: './assets/nano-icons/nanoicons',
              fontFamily: `icons-${lane}`,
            })),
          },
        ],
        [
          'react-native-edge-to-edge',
          {android: {enforceNavigationBarContrast: false}},
        ],
        // HORIZON: no Bitdrift (a proprietary network logging SDK)
        ...(USE_SENTRY
          ? [
              /** @type {[string, any]} */ ([
                '@sentry/react-native/expo',
                {
                  organization: 'blueskyweb',
                  project: 'app',
                  url: 'https://sentry.io',
                  experimental_android: {
                    enableAndroidGradlePlugin: true,
                  },
                },
              ]),
            ]
          : []),
        [
          'expo-build-properties',
          {
            ios: {
              deploymentTarget: '16.4',
              buildReactNativeFromSource: true,
              ccacheEnabled: IS_DEV,
              cxxLanguageStandard: 'c++23',
              extraPods: [
                {
                  name: 'MCEmojiPicker',
                  git: 'https://github.com/bluesky-social/MCEmojiPicker.git',
                  branch: 'main',
                },
              ],
            },
            android: {
              compileSdkVersion: 37,
              targetSdkVersion: 36,
              buildToolsVersion: '37.0.0',
              buildReactNativeFromSource: true,
              enableMinifyInReleaseBuilds: true,
            },
          },
        ],
        [
          'expo-notifications',
          {
            // HORIZON: Horizon's mark and its front-hill green
            icon: './assets/horizon/android-notification.png',
            color: '#2F6B3A',
            sounds: PLATFORM === 'ios' ? ['assets/dm.aiff'] : ['assets/dm.mp3'],
          },
        ],
        // HORIZON: the timed DM check for Horizon's push (#/horizon/push)
        'expo-background-task',
        './plugins/starterPackAppClipExtension/withStarterPackAppClip.js',
        './plugins/withGradleJVMHeapSizeIncrease.js',
        './plugins/withAndroidManifestLargeHeapPlugin.js',
        './plugins/withAndroidManifestFCMIconPlugin.js',
        './plugins/withAndroidManifestIntentQueriesPlugin.js',
        './plugins/withAndroidManifestOptionalCameraPlugin.js',
        './plugins/withAndroidStylesAccentColorPlugin.js',
        './plugins/withAndroidNoJitpackPlugin.js',
        './plugins/withAndroidPreparedTextLayoutPlugin.js',
        './plugins/withAndroidComposeVersion.js',
        './plugins/shareExtension/withShareExtensions.js',
        './plugins/notificationsExtension/withNotificationsExtension.js',
        [
          'expo-font',
          {
            ios: {
              /*
               * Uncompressed TTF rather than WOFF2: iOS decompresses WOFF2
               * fonts on every launch, which took ~200 ms of the startup
               * critical path. These are the same Inter 4.001 fonts as the
               * WOFF2 files used on web.
               */
              fonts: [
                './assets/fonts/inter/InterVariable.ttf',
                './assets/fonts/inter/InterVariable-Italic.ttf',
              ],
            },
            android: {
              fonts: [
                './assets/fonts/inter/InterVariable.woff2',
                './assets/fonts/inter/InterVariable-Italic.woff2',
                './assets/fonts/inter/Inter-Regular.otf',
                './assets/fonts/inter/Inter-Italic.otf',
                './assets/fonts/inter/Inter-Medium.otf',
                './assets/fonts/inter/Inter-MediumItalic.otf',
                './assets/fonts/inter/Inter-SemiBold.otf',
                './assets/fonts/inter/Inter-SemiBoldItalic.otf',
                './assets/fonts/inter/Inter-Bold.otf',
                './assets/fonts/inter/Inter-BoldItalic.otf',
              ],
            },
          },
        ],
        [
          'expo-splash-screen',
          {
            ios: {
              enableFullScreenImage_legacy: true, // iOS only
              backgroundColor: '#006AFF', // primary_500
              image: './assets/splash/splash.png',
              resizeMode: 'cover',
              dark: {
                enableFullScreenImage_legacy: true, // iOS only
                backgroundColor: '#002861', // primary_900
                image: './assets/splash/splash-dark.png',
                resizeMode: 'cover',
              },
            },
            /*
             * HORIZON: Horizon's mark. The icon's foreground layer keeps the
             * sun inside the circle Android masks a splash icon to; the
             * mark's sky shows behind it, and its ink at night
             */
            android: {
              backgroundColor: '#CFE5EE',
              image: './assets/horizon/android-foreground.png',
              imageWidth: 160,
              dark: {
                backgroundColor: '#1A1D33',
                image: './assets/horizon/android-foreground.png',
                imageWidth: 160,
              },
            },
          },
        ],
        // HORIZON: no Bluesky+ alternate icons (all Bluesky marks)
        ['expo-screen-orientation'],
        ['expo-location'],
        [
          'expo-contacts',
          {
            contactsPermission:
              // HORIZON: the app's own name
              'I agree to allow Horizon to use my contacts for friend discovery until I opt out.',
          },
        ],
      ],
      extra: {
        eas: {
          build: {
            experimental: {
              ios: {
                appExtensions: [
                  {
                    targetName: 'Share-with-Bluesky',
                    bundleIdentifier: 'xyz.blueskyweb.app.Share-with-Bluesky',
                    entitlements: {
                      'com.apple.security.application-groups': [
                        'group.app.bsky',
                      ],
                    },
                  },
                  {
                    targetName: 'BlueskyNSE',
                    bundleIdentifier: 'xyz.blueskyweb.app.BlueskyNSE',
                    entitlements: {
                      'com.apple.security.application-groups': [
                        'group.app.bsky',
                      ],
                    },
                  },
                  {
                    targetName: 'BlueskyClip',
                    bundleIdentifier: 'xyz.blueskyweb.app.AppClip',
                    parentBundleIdentifier: 'xyz.blueskyweb.app',
                    entitlements: {
                      'com.apple.security.application-groups': [
                        'group.app.bsky',
                      ],
                      'com.apple.developer.parent-application-identifiers': [
                        '$(AppIdentifierPrefix)xyz.blueskyweb.app',
                      ],
                      'com.apple.developer.associated-domains':
                        ASSOCIATED_DOMAINS,
                    },
                  },
                ],
              },
            },
          },
          // HORIZON: no EAS project; Bluesky's projectId and build cache are gone
        },
      },
    },
  }
}
