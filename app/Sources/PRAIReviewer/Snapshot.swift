import AppKit
import SwiftUI

/// 화면 확인과 README 스크린샷용. PR_AI_REVIEWER_SNAPSHOT_DIR가 있을 때만 설정 창과 메뉴 화면을 PNG로 저장한다.
/// 앱이 자기 창을 그리는 방식이라 화면 기록 권한이 필요 없다.
@MainActor
enum Snapshot {
    static let directory = ProcessInfo.processInfo.environment["PR_AI_REVIEWER_SNAPSHOT_DIR"]
        .map { URL(fileURLWithPath: $0, isDirectory: true) }

    static func captureAll(model: AppModel) async {
        guard let directory else { return }
        model.openSettings()
        // 환경 점검과 저장소 목록을 다 불러올 때까지 최대 60초 기다린다.
        for _ in 0..<120 {
            try? await Task.sleep(for: .milliseconds(500))
            let reposDone = !model.isLoadingRepos && (!model.repos.isEmpty || model.reposError != nil)
            if model.doctor != nil, !model.isCheckingEnvironment, reposDone { break }
        }
        try? await Task.sleep(for: .seconds(1))
        // 제목 막대가 있는 창은 화면 높이를 넘지 못해, 화면 밖 테두리 없는 창에 그려 모든 항목을 담는다.
        let settings = NSHostingView(rootView: SettingsView(model: model))
        await render(settings, size: NSSize(width: 620, height: 2100), to: directory.appendingPathComponent("settings.png"))
        let menu = NSHostingView(rootView: MenuView(model: model).background(Color(nsColor: .windowBackgroundColor)))
        await render(menu, size: menu.fittingSize, to: directory.appendingPathComponent("menu.png"))
    }

    private static func render(_ view: NSView, size: NSSize, to url: URL) async {
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = view
        view.layoutSubtreeIfNeeded()
        try? await Task.sleep(for: .milliseconds(800))
        write(view, to: url)
    }

    private static func write(_ view: NSView, to url: URL) {
        guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: bitmap)
        try? bitmap.representation(using: .png, properties: [:])?.write(to: url)
    }
}
