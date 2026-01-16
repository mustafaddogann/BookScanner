/**
 * PushNotificationIOS Shim
 *
 * This shim prevents the iOS crash:
 * "new NativeEventEmitter() requires a non-null argument"
 *
 * The native PushNotificationManager module is not linked in this app,
 * but something may be importing PushNotificationIOS. This shim provides
 * a safe no-op implementation.
 */

const noop = () => {};
const noopPromise = () => Promise.resolve(null);

// Safe no-op class that mimics PushNotificationIOS API
class PushNotificationIOSShim {
  static FetchResult = {
    NewData: 'UIBackgroundFetchResultNewData',
    NoData: 'UIBackgroundFetchResultNoData',
    ResultFailed: 'UIBackgroundFetchResultFailed',
  };

  static presentLocalNotification = noop;
  static scheduleLocalNotification = noop;
  static cancelAllLocalNotifications = noop;
  static removeAllDeliveredNotifications = noop;
  static getDeliveredNotifications = (cb) => cb([]);
  static removeDeliveredNotifications = noop;
  static setApplicationIconBadgeNumber = noop;
  static getApplicationIconBadgeNumber = (cb) => cb(0);
  static cancelLocalNotifications = noop;
  static getScheduledLocalNotifications = (cb) => cb([]);
  static addEventListener = noop;
  static removeEventListener = noop;
  static requestPermissions = () =>
    Promise.resolve({ alert: false, badge: false, sound: false });
  static abandonPermissions = noop;
  static checkPermissions = (cb) => cb({ alert: false, badge: false, sound: false });
  static getInitialNotification = noopPromise;
  static getAuthorizationStatus = (cb) => cb(0);

  constructor() {
    this._data = {};
    this._alert = null;
    this._sound = null;
    this._category = null;
    this._contentAvailable = null;
    this._badgeCount = null;
    this._notificationId = null;
    this._isRemote = false;
    this._threadID = null;
  }

  finish = noop;
  getMessage = () => null;
  getSound = () => null;
  getCategory = () => null;
  getAlert = () => null;
  getContentAvailable = () => null;
  getBadgeCount = () => null;
  getData = () => null;
  getThreadID = () => null;
}

export default PushNotificationIOSShim;
