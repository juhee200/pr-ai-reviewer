// 앱 아이콘 이미지 묶음(.iconset)을 그린다. scripts/build-app.sh가 iconutil로 .icns를 만든다.
// 사용법: swift app/make-icon.swift <출력 폴더>
import AppKit

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write(Data("사용법: swift app/make-icon.swift <출력 폴더>\n".utf8))
    exit(1)
}
let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

func drawIcon(pixels: Int) -> Data? {
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4,
        hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    ) else { return nil }
    NSGraphicsContext.saveGraphicsState()
    defer { NSGraphicsContext.restoreGraphicsState() }
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)

    // macOS 아이콘 격자: 1024px 기준 가운데 824px 둥근 사각형
    let size = CGFloat(pixels)
    let inset = size * 100 / 1024
    let tile = NSRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2)
    let shape = NSBezierPath(roundedRect: tile, xRadius: tile.width * 0.225, yRadius: tile.width * 0.225)
    let top = NSColor(srgbRed: 0.24, green: 0.52, blue: 0.98, alpha: 1)
    let bottom = NSColor(srgbRed: 0.36, green: 0.27, blue: 0.86, alpha: 1)
    NSGradient(starting: top, ending: bottom)?.draw(in: shape, angle: -90)

    // 말풍선은 흰색, 안의 글줄은 배경색으로 칠해 리뷰 코멘트처럼 보이게 한다.
    let lines = NSColor(srgbRed: 0.30, green: 0.40, blue: 0.92, alpha: 1)
    let configuration = NSImage.SymbolConfiguration(pointSize: tile.width * 0.46, weight: .semibold)
        .applying(NSImage.SymbolConfiguration(paletteColors: [lines, .white]))
    if let symbol = NSImage(systemSymbolName: "text.bubble.fill", accessibilityDescription: nil)?
        .withSymbolConfiguration(configuration) {
        let origin = NSPoint(x: tile.midX - symbol.size.width / 2, y: tile.midY - symbol.size.height / 2)
        symbol.draw(at: origin, from: .zero, operation: .sourceOver, fraction: 1)
    }
    return bitmap.representation(using: .png, properties: [:])
}

let sizes: [(name: String, pixels: Int)] = [
    ("icon_16x16", 16), ("icon_16x16@2x", 32), ("icon_32x32", 32), ("icon_32x32@2x", 64),
    ("icon_128x128", 128), ("icon_128x128@2x", 256), ("icon_256x256", 256), ("icon_256x256@2x", 512),
    ("icon_512x512", 512), ("icon_512x512@2x", 1024),
]
for (name, pixels) in sizes {
    guard let png = drawIcon(pixels: pixels) else {
        FileHandle.standardError.write(Data("아이콘을 그리지 못했습니다: \(name)\n".utf8))
        exit(1)
    }
    try png.write(to: output.appendingPathComponent("\(name).png"))
}
