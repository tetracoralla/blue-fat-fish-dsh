import AppKit
import EdgeCompanionCore
import ImageIO
import QuartzCore

struct DesktopPetManifest: Decodable {
    struct Frame: Decodable {
        let width: Int
        let height: Int
        let columns: Int
        let rows: Int
        let pixelRatio: Double?

        var logicalWidth: CGFloat { CGFloat(width) / CGFloat(columns) / CGFloat(pixelRatio ?? 1) }
        var logicalHeight: CGFloat { CGFloat(height) / CGFloat(rows) / CGFloat(pixelRatio ?? 1) }
    }

    struct Animation: Decodable {
        let frames: [Int]
        let fps: Double?
        let loop: Bool?
        let fallback: String?
        let durationsMilliseconds: [Int]?

        func duration(at index: Int) -> TimeInterval {
            if let durationsMilliseconds, durationsMilliseconds.indices.contains(index) {
                return TimeInterval(durationsMilliseconds[index]) / 1_000
            }
            return 1 / max(1, min(fps ?? 8, 60))
        }
    }

    struct Presentation: Decodable {
        let dragAnimation: String?
    }

    let id: String
    let frame: Frame
    let animations: [String: Animation]
    let presentation: Presentation?
}

private final class DesktopPetPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private final class CachedPetFrame {
    let image: CGImage
    init(_ image: CGImage) { self.image = image }
}

private final class PetFrameSequence {
    private let source: CGImageSource
    private let expectedSize: CGSize
    private let cache = NSCache<NSNumber, CachedPetFrame>()

    init?(path: String, expectedFrames: Int, expectedSize: CGSize) {
        guard let source = CGImageSourceCreateWithURL(
            URL(fileURLWithPath: path) as CFURL,
            [kCGImageSourceShouldCache: false] as CFDictionary
        ), CGImageSourceGetCount(source) == expectedFrames, expectedFrames > 0 else { return nil }
        self.source = source
        self.expectedSize = expectedSize
        cache.countLimit = 12
        cache.totalCostLimit = 12 * 1_024 * 1_024
        guard image(at: 0) != nil, image(at: expectedFrames - 1) != nil else { return nil }
    }

    func image(at index: Int) -> CGImage? {
        guard index >= 0, index < CGImageSourceGetCount(source) else { return nil }
        let key = NSNumber(value: index)
        if let cached = cache.object(forKey: key) { return cached.image }
        return autoreleasepool {
            guard let image = CGImageSourceCreateImageAtIndex(
                source,
                index,
                [kCGImageSourceShouldCacheImmediately: true] as CFDictionary
            ), image.width == Int(expectedSize.width), image.height == Int(expectedSize.height)
            else { return nil }
            cache.setObject(
                CachedPetFrame(image),
                forKey: key,
                cost: image.bytesPerRow * image.height
            )
            return image
        }
    }
}

private func loadPetAtlas(path: String, maximumPixelSize: Int, sourceMaximumPixelSize: Int) -> CGImage? {
    autoreleasepool {
        guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
        if maximumPixelSize >= sourceMaximumPixelSize {
            return CGImageSourceCreateImageAtIndex(source, 0, [
                kCGImageSourceShouldCacheImmediately: true,
            ] as CFDictionary)
        }
        guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true,
                kCGImageSourceThumbnailMaxPixelSize: maximumPixelSize,
              ] as CFDictionary),
              let context = CGContext(
                data: nil,
                width: thumbnail.width,
                height: thumbnail.height,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
              )
        else { return nil }
        context.interpolationQuality = .high
        context.draw(thumbnail, in: CGRect(x: 0, y: 0, width: thumbnail.width, height: thumbnail.height))
        return context.makeImage()
    }
}

@MainActor
final class DesktopPetController: NSObject {
    private static let canvasPadding: CGFloat = 18

    private let manifest: DesktopPetManifest
    private let panel: DesktopPetPanel
    private let spriteView: DesktopPetView
    private let frameSequence: PetFrameSequence?
    private let scale: CGFloat
    private var animationTimer: Timer?
    private var motion = PetMotion()
    private var animationName = "idle"
    private var frameOffset = 0

    init(manifestPath: String, sheetPath: String, sequencePath: String?, scale: CGFloat) throws {
        let manifestData = try Data(contentsOf: URL(fileURLWithPath: manifestPath))
        let decodedManifest = try JSONDecoder().decode(DesktopPetManifest.self, from: manifestData)
        manifest = decodedManifest
        let backingScale = NSScreen.screens.map(\.backingScaleFactor).max() ?? 2
        let maximumPixelSize = PetAtlasSizing.maximumPixelSize(
            sourceWidth: decodedManifest.frame.width,
            sourceHeight: decodedManifest.frame.height,
            columns: decodedManifest.frame.columns,
            rows: decodedManifest.frame.rows,
            logicalWidth: decodedManifest.frame.logicalWidth,
            logicalHeight: decodedManifest.frame.logicalHeight,
            presentationScale: scale,
            backingScale: backingScale
        )
        guard decodedManifest.frame.columns > 0, decodedManifest.frame.rows > 0,
              decodedManifest.frame.logicalWidth == 192, decodedManifest.frame.logicalHeight == 208
        else { throw DesktopPetError.invalidAssets }
        let expectedFrames = decodedManifest.frame.columns * decodedManifest.frame.rows
        let sequence = sequencePath.flatMap {
            PetFrameSequence(
                path: $0,
                expectedFrames: expectedFrames,
                expectedSize: CGSize(
                    width: decodedManifest.frame.width / decodedManifest.frame.columns,
                    height: decodedManifest.frame.height / decodedManifest.frame.rows
                )
            )
        }
        frameSequence = sequence
        let atlasImage: CGImage?
        if sequence != nil {
            atlasImage = nil
            print("[dsh-edge-companion] pet-frames count=\(expectedFrames) cache=12 backing=\(backingScale)")
        } else {
            atlasImage = loadPetAtlas(
                path: sheetPath,
                maximumPixelSize: maximumPixelSize,
                sourceMaximumPixelSize: max(decodedManifest.frame.width, decodedManifest.frame.height)
            )
            guard let atlasImage else { throw DesktopPetError.invalidAssets }
            print("[dsh-edge-companion] pet-atlas source=\(decodedManifest.frame.width)x\(decodedManifest.frame.height) decoded=\(atlasImage.width)x\(atlasImage.height) backing=\(backingScale)")
        }
        self.scale = scale
        let contentSize = CGSize(
            width: decodedManifest.frame.logicalWidth * scale + Self.canvasPadding * 2,
            height: decodedManifest.frame.logicalHeight * scale + Self.canvasPadding * 2
        )
        panel = DesktopPetPanel(
            contentRect: CGRect(origin: .zero, size: contentSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        spriteView = DesktopPetView(
            frame: CGRect(origin: .zero, size: contentSize),
            atlasImage: atlasImage,
            columns: decodedManifest.frame.columns,
            rows: decodedManifest.frame.rows,
            padding: Self.canvasPadding,
            petScale: scale
        )
        super.init()
        spriteView.owner = self
        panel.contentView = spriteView
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = false
        panel.isMovable = false
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.animationBehavior = .none
        restorePosition()
        setAnimation("idle")
    }

    func show() {
        panel.orderFrontRegardless()
    }

    func hide() {
        panel.orderOut(nil)
    }

    func receive(base: String, cue: String?, eventID: String?) {
        let previous = motion.animation
        motion.receive(base: base, cue: cue, eventID: eventID)
        if previous != motion.animation { setAnimation(motion.animation) }
    }

    private func setAnimation(_ requestedName: String, restart: Bool = false) {
        let name = manifest.animations[requestedName] == nil ? "idle" : requestedName
        guard let animation = manifest.animations[name], !animation.frames.isEmpty else { return }
        if animationName != name || restart {
            animationName = name
            frameOffset = 0
        }
        animationTimer?.invalidate()
        showFrame(animation.frames[frameOffset % animation.frames.count])
        let timer = Timer(timeInterval: animation.duration(at: frameOffset % animation.frames.count), repeats: false) { [weak self] _ in
            Task { @MainActor in self?.advanceAnimation() }
        }
        RunLoop.main.add(timer, forMode: .common)
        animationTimer = timer
    }

    private func advanceAnimation() {
        guard let animation = manifest.animations[animationName], !animation.frames.isEmpty else { return }
        frameOffset += 1
        if frameOffset >= animation.frames.count {
            if animation.loop == true {
                frameOffset = 0
            } else {
                motion.finished()
                // A second event with the same cue is intentionally queued by
                // PetMotion.  Restart even when its animation name is unchanged;
                // otherwise the exhausted cursor shows one frame and finishes.
                setAnimation(motion.animation, restart: true)
                return
            }
        }
        showFrame(animation.frames[frameOffset])
        animationTimer?.invalidate()
        let timer = Timer(timeInterval: animation.duration(at: frameOffset), repeats: false) { [weak self] _ in
            Task { @MainActor in self?.advanceAnimation() }
        }
        RunLoop.main.add(timer, forMode: .common)
        animationTimer = timer
    }

    private func showFrame(_ frame: Int) {
        if let image = frameSequence?.image(at: frame) {
            spriteView.show(image: image)
        } else {
            spriteView.show(atlasFrame: frame)
        }
    }

    fileprivate func dragBegan() {
        motion.beginDrag(direction: manifest.presentation?.dragAnimation ?? "running-right")
        setAnimation(motion.animation)
    }

    fileprivate func dragChanged(deltaX: CGFloat) {
        let directional = deltaX < 0 ? "running-left" : "running-right"
        if manifest.animations[directional] != nil, animationName != directional {
            motion.turn(left: deltaX < 0)
            setAnimation(motion.animation)
        }
    }

    fileprivate func dragEnded(moved: Bool) {
        persistPosition()
        if moved { motion.release() } else { motion.wave() }
        setAnimation(motion.animation)
    }

    fileprivate func movePanel(to origin: CGPoint) {
        panel.setFrameOrigin(origin)
    }

    fileprivate var panelOrigin: CGPoint { panel.frame.origin }

    private var positionKey: String { "openadam.desktop-pet.position.\(manifest.id)" }

    private func restorePosition() {
        let stored = UserDefaults.standard.array(forKey: positionKey) as? [Double]
        let origin: CGPoint
        if let stored, stored.count == 2 {
            origin = CGPoint(x: stored[0], y: stored[1])
        } else {
            let screen = NSScreen.main ?? NSScreen.screens.first
            origin = CGPoint(
                x: (screen?.visibleFrame.maxX ?? panel.frame.width) - panel.frame.width - 30,
                y: (screen?.visibleFrame.minY ?? 0) + 30
            )
        }
        panel.setFrameOrigin(clamped(origin: origin))
    }

    private func persistPosition() {
        let origin = clamped(origin: panel.frame.origin)
        panel.setFrameOrigin(origin)
        UserDefaults.standard.set([Double(origin.x), Double(origin.y)], forKey: positionKey)
    }

    private func clamped(origin: CGPoint) -> CGPoint {
        DesktopPetPlacement.clamp(
            panelFrame: CGRect(origin: origin, size: panel.frame.size),
            to: NSScreen.screens.map(\.visibleFrame)
        ).origin
    }
}

private enum DesktopPetError: LocalizedError {
    case invalidAssets
    var errorDescription: String? { "Invalid desktop pet manifest or sprite sheet" }
}

@MainActor
private final class DesktopPetView: NSView {
    weak var owner: DesktopPetController?
    private let imageLayer = CALayer()
    private let columns: Int
    private let rows: Int
    private let padding: CGFloat
    private let petScale: CGFloat
    private var mouseStart = CGPoint.zero
    private var originStart = CGPoint.zero
    private var previousMouseX: CGFloat = 0
    private var moved = false

    init(frame: CGRect, atlasImage: CGImage?, columns: Int, rows: Int, padding: CGFloat, petScale: CGFloat) {
        self.columns = columns
        self.rows = rows
        self.padding = padding
        self.petScale = petScale
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
        imageLayer.contents = atlasImage
        imageLayer.contentsGravity = .resize
        imageLayer.magnificationFilter = .linear
        imageLayer.minificationFilter = .trilinear
        imageLayer.allowsEdgeAntialiasing = true
        layer?.addSublayer(imageLayer)
        updateLayerFrame()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func layout() {
        super.layout()
        updateLayerFrame()
    }

    private func updateLayerFrame() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        imageLayer.frame = CGRect(
            x: padding,
            y: padding,
            width: 192 * petScale,
            height: 208 * petScale
        )
        imageLayer.contentsScale = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
        CATransaction.commit()
    }

    func show(atlasFrame frame: Int) {
        let column = frame % columns
        let row = frame / columns
        guard row >= 0, row < rows else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        imageLayer.contentsRect = CGRect(
            x: CGFloat(column) / CGFloat(columns),
            y: 1 - CGFloat(row + 1) / CGFloat(rows),
            width: 1 / CGFloat(columns),
            height: 1 / CGFloat(rows)
        )
        CATransaction.commit()
    }

    func show(image: CGImage) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        imageLayer.contents = image
        imageLayer.contentsRect = CGRect(x: 0, y: 0, width: 1, height: 1)
        CATransaction.commit()
    }

    override func mouseDown(with event: NSEvent) {
        mouseStart = NSEvent.mouseLocation
        originStart = owner?.panelOrigin ?? .zero
        previousMouseX = mouseStart.x
        moved = false
    }

    override func mouseDragged(with event: NSEvent) {
        let mouse = NSEvent.mouseLocation
        let delta = CGPoint(x: mouse.x - mouseStart.x, y: mouse.y - mouseStart.y)
        if !moved, abs(delta.x) + abs(delta.y) > 4 {
            moved = true
            owner?.dragBegan()
        }
        if moved, abs(mouse.x - previousMouseX) > 6 {
            owner?.dragChanged(deltaX: mouse.x - previousMouseX)
            previousMouseX = mouse.x
        }
        if moved {
            owner?.movePanel(to: CGPoint(x: originStart.x + delta.x, y: originStart.y + delta.y))
        }
    }

    override func mouseUp(with event: NSEvent) {
        owner?.dragEnded(moved: moved)
    }
}
