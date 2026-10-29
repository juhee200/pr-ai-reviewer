import AppKit
import SwiftUI

@main
struct PRAIReviewerApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    private let model = AppModel.shared

    var body: some Scene {
        MenuBarExtra {
            MenuView(model: model)
        } label: {
            Image(systemName: model.menuBarSymbol)
        }
        .menuBarExtraStyle(.window)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // CLI 표준 입력에 쓰는 중 CLI가 먼저 끝나도 앱이 SIGPIPE로 종료되지 않게 한다.
        signal(SIGPIPE, SIG_IGN)
        // 같은 앱이 이미 메뉴바에 있으면 아이콘이 두 개가 되지 않게 끝낸다.
        if let bundleID = Bundle.main.bundleIdentifier,
           NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).contains(where: { $0 != NSRunningApplication.current }) {
            NSApp.terminate(nil)
            return
        }
        Task { await AppModel.shared.start() }
    }
}
