import AppKit
import SwiftUI

/// 메뉴바 앱(LSUIElement)에서도 앞으로 나오도록 설정 창을 AppKit 창으로 띄운다.
@MainActor
final class SettingsWindowController {
    static let shared = SettingsWindowController()
    private var window: NSWindow?

    func show(model: AppModel) {
        let window = self.window ?? makeWindow(model: model)
        self.window = window
        NSApp.activate()
        window.makeKeyAndOrderFront(nil)
    }

    private func makeWindow(model: AppModel) -> NSWindow {
        let controller = NSHostingController(rootView: SettingsView(model: model))
        controller.sizingOptions = [.minSize]
        let window = NSWindow(contentViewController: controller)
        window.title = "PR AI Reviewer 설정"
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        window.setContentSize(NSSize(width: 620, height: 780))
        window.isReleasedWhenClosed = false
        window.center()
        return window
    }
}
