import AppKit

/// 메뉴바 아이콘. 마스코트 리뷰엉이(Contents/Resources/MenuBarOwl.png)에 상태를 겹쳐 그린다.
/// - 리뷰 중: 파란 점 / 확인 필요: 주황 점 / 일시정지: 흐리게
/// 앱 번들 밖에서 실행해 이미지가 없으면(swift run) 상태별 SF Symbol로 대신한다.
@MainActor
enum MenuBarIcon {
    /// 메뉴바 높이 22pt 안에 다른 상태 아이콘과 비슷한 크기로 들어가는 값.
    private static let size = NSSize(width: 18, height: 18)
    private static let badgeDiameter: CGFloat = 7
    private static let owl = Bundle.main.image(forResource: "MenuBarOwl")

    static func image(for state: AppModel.MenuBarState) -> NSImage {
        guard let owl else { return symbol(for: state) }
        let badgeColor: NSColor? = switch state {
        case .reviewing: .systemBlue
        case .attention: .systemOrange
        case .watching, .paused: nil
        }
        let image = NSImage(size: size, flipped: false) { rect in
            owl.draw(in: rect, from: .zero, operation: .sourceOver, fraction: state == .paused ? 0.45 : 1)
            guard let badgeColor else { return true }
            // 점 둘레를 투명하게 비워 부엉이 몸통과 점이 섞이지 않게 한다.
            let badge = NSRect(x: rect.maxX - badgeDiameter, y: rect.minY, width: badgeDiameter, height: badgeDiameter)
            NSGraphicsContext.current?.compositingOperation = .clear
            NSBezierPath(ovalIn: badge.insetBy(dx: -1.5, dy: -1.5)).fill()
            NSGraphicsContext.current?.compositingOperation = .sourceOver
            badgeColor.setFill()
            NSBezierPath(ovalIn: badge).fill()
            return true
        }
        // 색이 있는 마스코트라 template으로 두지 않는다. template이면 메뉴바가 단색으로 칠한다.
        image.isTemplate = false
        image.accessibilityDescription = description(for: state)
        return image
    }

    private static func symbol(for state: AppModel.MenuBarState) -> NSImage {
        let name = switch state {
        case .watching: "text.bubble"
        case .reviewing: "ellipsis.bubble"
        case .paused: "pause.circle"
        case .attention: "exclamationmark.bubble"
        }
        return NSImage(systemSymbolName: name, accessibilityDescription: description(for: state)) ?? NSImage()
    }

    private static func description(for state: AppModel.MenuBarState) -> String {
        switch state {
        case .watching: "리뷰엉이: 감시 중"
        case .reviewing: "리뷰엉이: 리뷰 중"
        case .paused: "리뷰엉이: 일시정지됨"
        case .attention: "리뷰엉이: 확인 필요"
        }
    }
}
