const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');
const path = require('path');

module.exports = (async () => {
  const defaultConfig = await getDefaultConfig(__dirname);

  return mergeConfig(defaultConfig, {
    resolver: {
      useWatchman: false,
      // Intercept PushNotificationIOS imports and redirect to shim
      // Fixes iOS crash: "new NativeEventEmitter() requires a non-null argument"
      resolveRequest: (context, moduleName, platform) => {
        // Redirect any PushNotificationIOS imports to our shim
        if (
          moduleName === './Libraries/PushNotificationIOS/PushNotificationIOS' ||
          moduleName.includes('PushNotificationIOS/PushNotificationIOS')
        ) {
          return {
            filePath: path.resolve(__dirname, 'src/shims/PushNotificationIOSShim.js'),
            type: 'sourceFile',
          };
        }
        // Fall back to default resolution
        return context.resolveRequest(context, moduleName, platform);
      },
    },
  });
})();
