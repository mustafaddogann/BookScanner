import UIKit
import React
import React_RCTAppDelegate

@main
@objcMembers
class AppDelegate: UIResponder, UIApplicationDelegate {

  // Compatibility shim: some libraries access UIApplication.shared.delegate.window
  // which crashes on RN 0.83+ (SceneDelegate architecture). Forward to the active scene.
  @objc var window: UIWindow? {
    get {
      guard let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene else {
        return nil
      }
      return scene.windows.first
    }
    // swiftlint:disable:next unused_setter_value
    set { }
  }

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    // Application-level initialization
    // React Native setup is now handled in SceneDelegate
    return true
  }

  // MARK: UISceneSession Lifecycle

  func application(
    _ application: UIApplication,
    configurationForConnecting connectingSceneSession: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    // Called when a new scene session is being created.
    // Use this method to select a configuration to create the new scene with.
    return UISceneConfiguration(
      name: "Default Configuration",
      sessionRole: connectingSceneSession.role
    )
  }

  func application(
    _ application: UIApplication,
    didDiscardSceneSessions sceneSessions: Set<UISceneSession>
  ) {
    // Called when the user discards a scene session.
    // Use this method to release any resources that were specific to the discarded scenes.
  }
}
