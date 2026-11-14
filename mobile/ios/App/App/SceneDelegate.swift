import UIKit
import Capacitor
import UserNotifications

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = DiscipleBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)

        // Cold start from a home screen shortcut: open its page once the site has had a moment to load.
        if let item = connectionOptions.shortcutItem {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in self?.openShortcut(item) }
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    // Long-press the app icon: Play now, Free play, Launch a coin, Trading Duel (Info.plist UIApplicationShortcutItems).
    func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem, completionHandler: @escaping (Bool) -> Void) {
        completionHandler(openShortcut(shortcutItem))
    }

    // Opening the app clears the unread badge that push alerts set.
    func sceneDidBecomeActive(_ scene: UIScene) {
        if #available(iOS 16.0, *) {
            UNUserNotificationCenter.current().setBadgeCount(0) { _ in }
        } else {
            UIApplication.shared.applicationIconBadgeNumber = 0
        }
    }

    @discardableResult
    private func openShortcut(_ item: UIApplicationShortcutItem) -> Bool {
        guard let path = item.userInfo?["path"] as? String,
              let bridgeVC = window?.rootViewController as? CAPBridgeViewController,
              let base = bridgeVC.bridge?.config.serverURL,
              let url = URL(string: path, relativeTo: base) else { return false }
        bridgeVC.webView?.load(URLRequest(url: url))
        return true
    }
}
