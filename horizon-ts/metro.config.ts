// Learn more https://docs.expo.io/guides/customizing-metro
import {getBundleModeMetroConfig} from 'react-native-worklets/bundleMode/index.js'
import {type CustomResolver} from '@expo/metro/metro-resolver'
import {getDefaultConfig} from '@expo/metro-config'
import {getSentryExpoConfig} from '@sentry/react-native/metro.js'

let config = getSentryExpoConfig(import.meta.dirname, {
  // TODO: confirm this doesn't break anything when we switch to metro web
  includeWebReplay: false,
  includeWebFeedback: false,
  annotateReactComponents: {
    textComponentNames: ['Text', 'ButtonText'],
  },
  getDefaultConfig: (projectRoot, options) => {
    const config = getDefaultConfig(projectRoot, options)

    if (typeof process.env.RN_SRC_EXT === 'string') {
      // inject `.e2e.ts` and `.e2e.tsx` into the sourceExts when running tests)
      config.resolver.sourceExts.unshift(...process.env.RN_SRC_EXT.split(','))
    }

    // HORIZON: 'wasm' for the private post encoder's module (src/horizon/private/encoder)
    config.resolver.assetExts = [...config.resolver.assetExts, 'woff2', 'wasm']

    if (config.resolver.resolveRequest) {
      throw Error('Update this override because it is conflicting now.')
    }

    if (process.env.BSKY_PROFILE) {
      // @ts-expect-error readonly property
      config.cacheVersion += ':PROFILE'
    }

    const resolver: CustomResolver = (context, moduleName, platform) => {
      if (
        platform === 'web' &&
        /^react-native-gesture-handler(\/|$)/.test(moduleName)
      ) {
        throw new Error(
          `react-native-gesture-handler must not be imported on web (requested from ${context.originModulePath})`,
        )
      }
      /*
       * react-native-webview has no web implementation (its fallback renders
       * "does not support this platform"), so swap in react-native-web-webview
       * to keep external media embeds working. Mirrors the old webpack alias.
       */
      if (platform === 'web' && moduleName === 'react-native-webview') {
        return context.resolveRequest(
          context,
          'react-native-web-webview',
          platform,
        )
      }
      /*
       * HORIZON: the Expo OAuth client (native app sign-in) imports its
       * platform-split files with an explicit `.js` (ESM style), which Metro
       * resolves literally; without it Metro picks `.native.js` or `.web.js`
       */
      if (
        /[\\/]@atproto[\\/]oauth-client-expo[\\/]dist[\\/]/.test(
          context.originModulePath,
        ) &&
        (moduleName === './expo-oauth-client.js' ||
          moduleName === './polyfill.js')
      ) {
        return context.resolveRequest(
          context,
          moduleName.slice(0, -'.js'.length),
          platform,
        )
      }
      /*
       * HORIZON: the same client's core-js polyfill broke
       * `Function.prototype.toString` (a recursion on the first call), so it
       * gets Horizon's own small polyfill instead
       */
      if (moduleName === 'core-js/proposals/explicit-resource-management') {
        return {
          type: 'sourceFile',
          filePath: `${import.meta.dirname}/src/horizon/polyfills/explicit-resource-management.ts`,
        }
      }
      if (
        process.env.BSKY_PROFILE &&
        moduleName.endsWith('ReactNativeRenderer-prod')
      ) {
        return context.resolveRequest(
          context,
          moduleName.replace('-prod', '-profiling'),
          platform,
        )
      }
      return context.resolveRequest(context, moduleName, platform)
    }

    // @ts-expect-error readonly property
    config.resolver.resolveRequest = resolver

    config.transformer.getTransformOptions = () =>
      Promise.resolve({
        transform: {
          experimentalImportSupport: true,
          inlineRequires: true as false, // ??? typescript why?
        },
      })

    return config as unknown as Record<string, unknown>
  },
})

config = getBundleModeMetroConfig(config)

export default config
