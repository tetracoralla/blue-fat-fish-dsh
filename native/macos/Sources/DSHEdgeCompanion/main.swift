import AppKit
import CoreGraphics
import EdgeCompanionCore
import QuartzCore
import Darwin

private struct Options {
    var characterPath = ""
    var petManifestPath = ""
    var petSheetPath = ""
    var petSequencePath = ""
    var petScale: CGFloat = 1.2
    var ownerName = "DeepSeek Harness"
    var insideWidth: CGFloat = 340
    var outsideWidth: CGFloat = 300
    var heightRatio: CGFloat = 1.08
    var maximumHeight: CGFloat = 900
    var shrinkThreshold: CGFloat = 960
    var minimumResponsiveScale: CGFloat = 0.68
    var windowCornerRadius: CGFloat = 12
    var seamOverlap: CGFloat = 1.25
    var parentPID: pid_t?

    static func parse(_ arguments: [String]) throws -> Options {
        var options = Options()
        var index = 1
        while index < arguments.count {
            let key = arguments[index]
            guard index + 1 < arguments.count else { throw OptionError.missingValue(key) }
            let value = arguments[index + 1]
            switch key {
            case "--character": options.characterPath = value
            case "--pet-manifest": options.petManifestPath = value
            case "--pet-sheet": options.petSheetPath = value
            case "--pet-sequence": options.petSequencePath = value
            case "--pet-scale":
                guard let number = Double(value), number >= 0.75, number <= 2.25 else { throw OptionError.invalidValue(key) }
                options.petScale = CGFloat(number)
            case "--owner": options.ownerName = value
            case "--inside-width":
                guard let number = Double(value), number >= 180, number <= 720 else { throw OptionError.invalidValue(key) }
                options.insideWidth = CGFloat(number)
            case "--outside-width":
                guard let number = Double(value), number >= 120, number <= 720 else { throw OptionError.invalidValue(key) }
                options.outsideWidth = CGFloat(number)
            case "--height-ratio":
                guard let number = Double(value), number >= 0.5, number <= 2 else { throw OptionError.invalidValue(key) }
                options.heightRatio = CGFloat(number)
            case "--maximum-height":
                guard let number = Double(value), number >= 320, number <= 1600 else { throw OptionError.invalidValue(key) }
                options.maximumHeight = CGFloat(number)
            case "--shrink-threshold":
                guard let number = Double(value), number >= 500, number <= 2000 else { throw OptionError.invalidValue(key) }
                options.shrinkThreshold = CGFloat(number)
            case "--minimum-responsive-scale":
                guard let number = Double(value), number >= 0.3, number <= 1 else { throw OptionError.invalidValue(key) }
                options.minimumResponsiveScale = CGFloat(number)
            case "--window-corner-radius":
                guard let number = Double(value), number >= 0, number <= 40 else { throw OptionError.invalidValue(key) }
                options.windowCornerRadius = CGFloat(number)
            case "--seam-overlap":
                guard let number = Double(value), number >= 0, number <= 4 else { throw OptionError.invalidValue(key) }
                options.seamOverlap = CGFloat(number)
            case "--parent-pid":
                guard let number = Int32(value), number > 1 else { throw OptionError.invalidValue(key) }
                options.parentPID = pid_t(number)
            default: throw OptionError.unknownOption(key)
            }
            index += 2
        }
        let hasPet = !options.petManifestPath.isEmpty && !options.petSheetPath.isEmpty
        let incompletePet = options.petManifestPath.isEmpty != options.petSheetPath.isEmpty
        if incompletePet { throw OptionError.missingValue(options.petManifestPath.isEmpty ? "--pet-manifest" : "--pet-sheet") }
        guard !options.characterPath.isEmpty || hasPet else { throw OptionError.missingValue("--character or --pet-manifest") }
        return options
    }
}

private enum OptionError: LocalizedError {
    case missingValue(String)
    case invalidValue(String)
    case unknownOption(String)

    var errorDescription: String? {
        switch self {
        case .missingValue(let key): return "Missing value for \(key)"
        case .invalidValue(let key): return "Invalid value for \(key)"
        case .unknownOption(let key): return "Unknown option \(key)"
        }
    }
}

private final class ClickThroughPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        frameRect
    }
}

private final class CharacterView: NSView {
    private let imageLayer = CALayer()
    private let alphaMask = CAShapeLayer()
    private var hostEdgeX: CGFloat = 0
    private var hostTopY: CGFloat = 0
    private let windowCornerRadius: CGFloat
    private let seamOverlap: CGFloat

    init(image: NSImage, windowCornerRadius: CGFloat, seamOverlap: CGFloat) {
        self.windowCornerRadius = windowCornerRadius
        self.seamOverlap = seamOverlap
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
        imageLayer.contents = image
        imageLayer.contentsGravity = .resizeAspect
        imageLayer.magnificationFilter = .linear
        imageLayer.minificationFilter = .trilinear
        imageLayer.allowsEdgeAntialiasing = true
        alphaMask.fillColor = NSColor.white.cgColor
        alphaMask.fillRule = .evenOdd
        imageLayer.mask = alphaMask
        layer?.addSublayer(imageLayer)
        updateMask()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        imageLayer.frame = bounds
        alphaMask.frame = imageLayer.bounds
        updateMask()
        CATransaction.commit()
    }

    func setHostBoundary(edgeX: CGFloat, topY: CGFloat) {
        guard edgeX != hostEdgeX || topY != hostTopY else { return }
        hostEdgeX = edgeX
        hostTopY = topY
        updateMask()
    }

    private func updateMask() {
        let outer = imageLayer.bounds
        let path = CGMutablePath()
        path.addRect(outer)
        path.addPath(EdgeMask.hiddenHostPath(
            bounds: outer,
            hostEdgeX: hostEdgeX,
            hostTopY: hostTopY,
            cornerRadius: windowCornerRadius,
            seamOverlap: seamOverlap
        ))
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        alphaMask.path = path
        CATransaction.commit()
    }
}

private struct HostWindow {
    let id: CGWindowID
    let quartzFrame: CGRect
    let ownerPID: pid_t
}

private struct ClientMessage: Decodable, Sendable {
    let kind: String?
    let x: CGFloat?
    let y: CGFloat?
    let width: CGFloat?
    let height: CGFloat?
    let base: String?
    let cue: String?
    let eventID: String?

    var validQuartzFrame: CGRect? {
        guard let x, let y, let width, let height,
              [x, y, width, height].allSatisfy(\.isFinite),
              abs(x) <= 32_000, abs(y) <= 32_000,
              width >= 320, width <= 10_000, height >= 240, height <= 10_000
        else { return nil }
        return CGRect(x: x, y: y, width: width, height: height)
    }
}

private struct EdgeGeometryPayload: Encodable, Equatable {
    let width: CGFloat
    let height: CGFloat
    let effectiveOutside: CGFloat
    let hostEdgeX: CGFloat
    let hostTopY: CGFloat
    let scale: CGFloat
}

private struct HelperProtocolMessage: Encodable {
    let kind = "edge-layout"
    let geometry: EdgeGeometryPayload
}

private enum HostWindowLocator {
    static func largestWindow(ownerName: String) -> HostWindow? {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return nil }
        return raw.compactMap { parse($0, ownerName: ownerName) }.max { left, right in
            left.quartzFrame.width * left.quartzFrame.height < right.quartzFrame.width * right.quartzFrame.height
        }
    }

    static func window(id: CGWindowID, ownerName: String) -> HostWindow? {
        guard let raw = CGWindowListCopyWindowInfo(.optionIncludingWindow, id) as? [[String: Any]],
              let info = raw.first,
              (info[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue == true
        else { return nil }
        return parse(info, ownerName: ownerName)
    }

    private static func parse(_ info: [String: Any], ownerName: String) -> HostWindow? {
        guard (info[kCGWindowOwnerName as String] as? String) == ownerName,
              (info[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              let bounds = info[kCGWindowBounds as String] as? NSDictionary,
              let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary),
              frame.width >= 500,
              frame.height >= 360,
              let pidNumber = info[kCGWindowOwnerPID as String] as? NSNumber,
              let idNumber = info[kCGWindowNumber as String] as? NSNumber
        else { return nil }
        return HostWindow(id: CGWindowID(idNumber.uint32Value), quartzFrame: frame, ownerPID: pid_t(pidNumber.intValue))
    }
}

@MainActor
private final class EdgeCompanionDelegate: NSObject, NSApplicationDelegate {
    private let options: Options
    private let panel: ClickThroughPanel?
    private let characterView: CharacterView?
    private let desktopPet: DesktopPetController?
    private var timer: Timer?
    private var interactionTrackingTimer: Timer?
    private var interactionSettleTimer: Timer?
    private var interactionTrackingExpiresAt: TimeInterval = 0
    private var globalMouseMonitor: Any?
    private var interactionActive = false
    private var lastFrame = CGRect.null
    private var lastEmittedGeometry: EdgeGeometryPayload?
    private var hostWindowID: CGWindowID?
    private var cachedHost: HostWindow?
    private var liveHostFrame: CGRect?
    private var liveHostFrameReceivedAt: TimeInterval = 0
    private var frontmostPID: pid_t?
    private var wasVisible = false

    init(options: Options, image: NSImage?, desktopPet: DesktopPetController?) {
        self.options = options
        self.desktopPet = desktopPet
        if let image {
            let view = CharacterView(
                image: image,
                windowCornerRadius: options.windowCornerRadius,
                seamOverlap: options.seamOverlap
            )
            let edgePanel = ClickThroughPanel(
                contentRect: .zero,
                styleMask: [.borderless, .nonactivatingPanel],
                backing: .buffered,
                defer: false
            )
            characterView = view
            panel = edgePanel
        } else {
            characterView = nil
            panel = nil
        }
        super.init()
        if let panel, let characterView {
            panel.contentView = characterView
            panel.isOpaque = false
            panel.backgroundColor = .clear
            panel.hasShadow = false
            panel.ignoresMouseEvents = true
            panel.isMovable = false
            panel.isReleasedWhenClosed = false
            panel.hidesOnDeactivate = false
            panel.level = .floating
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        desktopPet?.show()
        frontmostPID = NSWorkspace.shared.frontmostApplication?.processIdentifier
        startFrameReader()
        startHostInteractionMonitor()
        NSWorkspace.shared.notificationCenter.addObserver(
            self,
            selector: #selector(workspaceDidActivate(_:)),
            name: NSWorkspace.didActivateApplicationNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(screenParametersDidChange(_:)),
            name: NSApplication.didChangeScreenParametersNotification,
            object: nil
        )
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick(refreshFrontmost: true) }
        }
        timer.tolerance = 0.25
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        tick(refreshFrontmost: true)
    }

    @objc private func workspaceDidActivate(_ notification: Notification) {
        frontmostPID = (notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.processIdentifier
        tick()
    }

    @objc private func screenParametersDidChange(_ notification: Notification) {
        lastFrame = .null
        tick(refreshFrontmost: true)
    }

    private func startHostInteractionMonitor() {
        globalMouseMonitor = NSEvent.addGlobalMonitorForEvents(
            matching: [.leftMouseDown, .leftMouseDragged, .leftMouseUp]
        ) { [weak self] event in
            Task { @MainActor [weak self] in self?.receiveHostInteraction(event) }
        }
    }

    private func receiveHostInteraction(_ event: NSEvent) {
        switch event.type {
        case .leftMouseDown:
            guard mouseIsInsideHostWindow() else { return }
            interactionActive = true
            refreshInteractionTracking()
            tick(forceObserved: true)
        case .leftMouseDragged:
            if !interactionActive {
                guard mouseIsInsideHostWindow() else { return }
                interactionActive = true
            }
            refreshInteractionTracking()
            tick(forceObserved: true)
        case .leftMouseUp:
            guard interactionActive else { return }
            liveHostFrameReceivedAt = 0
            tick(forceObserved: true)
            endInteractionTracking(settle: true)
        default:
            break
        }
    }

    private func mouseIsInsideHostWindow() -> Bool {
        guard let host = cachedHost else { return false }
        let mainDisplayMaxY = NSScreen.screens.first?.frame.maxY ?? NSScreen.main?.frame.maxY ?? 0
        let hostFrame = DesktopCoordinateSpace.appKitFrame(
            from: host.quartzFrame,
            mainDisplayMaxY: mainDisplayMaxY
        )
        return HostInteractionRegion.contains(NSEvent.mouseLocation, hostFrame: hostFrame)
    }

    /// Global mouse events can arrive just before WindowServer commits the
    /// corresponding host-window frame. A single read in that callback then
    /// leaves the companion one drag event behind. During direct manipulation
    /// only, sample accepted WindowServer geometry independently at 120 Hz.
    /// This preserves system snap/cross-display truth without pointer
    /// prediction and adds no polling cost while the user is idle.
    private func refreshInteractionTracking() {
        interactionTrackingExpiresAt = ProcessInfo.processInfo.systemUptime + 0.5
        guard interactionTrackingTimer == nil else { return }
        interactionSettleTimer?.invalidate()
        interactionSettleTimer = nil
        let timer = Timer(timeInterval: 1.0 / 120.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                if ProcessInfo.processInfo.systemUptime >= self.interactionTrackingExpiresAt {
                    self.endInteractionTracking(settle: true)
                } else {
                    self.tick(forceObserved: true)
                }
            }
        }
        timer.tolerance = 0
        RunLoop.main.add(timer, forMode: .common)
        interactionTrackingTimer = timer
    }

    private func endInteractionTracking(settle: Bool) {
        interactionActive = false
        interactionTrackingExpiresAt = 0
        interactionTrackingTimer?.invalidate()
        interactionTrackingTimer = nil
        if settle { scheduleInteractionSettleTick() }
    }

    private func scheduleInteractionSettleTick() {
        interactionSettleTimer?.invalidate()
        let timer = Timer(timeInterval: 1.0 / 60.0, repeats: false) { [weak self] _ in
            Task { @MainActor in
                self?.interactionSettleTimer = nil
                self?.tick(forceObserved: true)
            }
        }
        timer.tolerance = 0
        RunLoop.main.add(timer, forMode: .common)
        interactionSettleTimer = timer
    }

    private func startFrameReader() {
        DispatchQueue.global(qos: .userInteractive).async { [weak self] in
            let decoder = JSONDecoder()
            while let line = readLine() {
                guard let data = line.data(using: .utf8),
                      let message = try? decoder.decode(ClientMessage.self, from: data)
                else { continue }
                Task { @MainActor [weak self] in self?.receive(message) }
            }
        }
    }

    private func receive(_ message: ClientMessage) {
        if message.kind == "pet-state", let base = message.base {
            desktopPet?.receive(base: base, cue: message.cue, eventID: message.eventID)
            return
        }
        guard let frame = message.validQuartzFrame else { return }
        liveHostFrame = frame
        liveHostFrameReceivedAt = ProcessInfo.processInfo.systemUptime
        tick()
    }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        interactionTrackingTimer?.invalidate()
        interactionSettleTimer?.invalidate()
        if let globalMouseMonitor { NSEvent.removeMonitor(globalMouseMonitor) }
        globalMouseMonitor = nil
        NSWorkspace.shared.notificationCenter.removeObserver(self)
        NotificationCenter.default.removeObserver(self)
    }

    private func tick(refreshFrontmost: Bool = false, forceObserved: Bool = false) {
        if let parentPID = options.parentPID, kill(parentPID, 0) != 0, errno == ESRCH {
            NSApp.terminate(nil)
            return
        }
        guard panel != nil else { return }
        let now = ProcessInfo.processInfo.systemUptime
        let freshLiveFrame = now - liveHostFrameReceivedAt <= 0.5 ? liveHostFrame : nil
        let host: HostWindow?
        if forceObserved || interactionActive {
            host = hostWindowID.flatMap { HostWindowLocator.window(id: $0, ownerName: options.ownerName) }
                ?? HostWindowLocator.largestWindow(ownerName: options.ownerName)
            if let host { cachedHost = host }
        } else if let freshLiveFrame, let cachedHost {
            host = HostWindow(id: cachedHost.id, quartzFrame: freshLiveFrame, ownerPID: cachedHost.ownerPID)
        } else {
            host = hostWindowID.flatMap { HostWindowLocator.window(id: $0, ownerName: options.ownerName) }
                ?? HostWindowLocator.largestWindow(ownerName: options.ownerName)
            if let host { cachedHost = host }
        }
        guard let host else {
            hostWindowID = nil
            cachedHost = nil
            if wasVisible {
                panel?.orderOut(nil)
                wasVisible = false
            }
            return
        }
        hostWindowID = host.id
        place(host)

        if refreshFrontmost {
            frontmostPID = NSWorkspace.shared.frontmostApplication?.processIdentifier
        }
        if frontmostPID == host.ownerPID, let panel {
            if !wasVisible {
                panel.orderFrontRegardless()
                fputs("[dsh-edge-companion] visible owner=\(options.ownerName)\n", stderr)
            }
            wasVisible = true
        } else {
            if wasVisible {
                panel?.orderOut(nil)
                let pidDescription = frontmostPID.map(String.init) ?? "none"
                fputs("[dsh-edge-companion] hidden frontmostPID=\(pidDescription)\n", stderr)
            }
            wasVisible = false
        }
    }

    private func place(_ host: HostWindow) {
        guard let panel, let characterView else { return }
        let mainDisplayMaxY = NSScreen.screens.first?.frame.maxY ?? NSScreen.main?.frame.maxY ?? 0
        let hostFrame = DesktopCoordinateSpace.appKitFrame(
            from: host.quartzFrame,
            mainDisplayMaxY: mainDisplayMaxY
        )
        let layout = EdgeLayout.place(
            hostFrame: hostFrame,
            insideWidth: options.insideWidth,
            outsideWidth: options.outsideWidth,
            heightRatio: options.heightRatio,
            maximumHeight: options.maximumHeight,
            shrinkThreshold: options.shrinkThreshold,
            minimumResponsiveScale: options.minimumResponsiveScale,
            containRightEdge: HostWindowState.isMaximized(
                hostFrame: hostFrame,
                candidateFrames: NSScreen.screens.flatMap { [$0.visibleFrame, $0.frame] }
            )
        )
        if layout.panelFrame != lastFrame {
            panel.setFrame(layout.panelFrame, display: true)
            lastFrame = layout.panelFrame
        }
        emit(layout)
        characterView.setHostBoundary(edgeX: layout.hostEdgeX, topY: layout.hostTopY)
    }

    private func emit(_ layout: EdgeCompanionLayout) {
        let geometry = EdgeGeometryPayload(
            width: layout.panelFrame.width,
            height: layout.panelFrame.height,
            effectiveOutside: layout.effectiveOutsideWidth,
            hostEdgeX: layout.hostEdgeX,
            hostTopY: layout.hostTopY,
            scale: layout.scale
        )
        guard geometry != lastEmittedGeometry else { return }
        lastEmittedGeometry = geometry
        let message = HelperProtocolMessage(geometry: geometry)
        guard var data = try? JSONEncoder().encode(message) else { return }
        data.append(0x0a)
        FileHandle.standardOutput.write(data)
    }
}

MainActor.assumeIsolated {
    do {
        setbuf(stdout, nil)
        let options = try Options.parse(CommandLine.arguments)
        let image: NSImage?
        if options.characterPath.isEmpty {
            image = nil
        } else {
            image = NSImage(contentsOfFile: options.characterPath)
            if image == nil {
                fputs("Unable to read character image: \(options.characterPath)\n", stderr)
                exit(2)
            }
        }
        let desktopPet = options.petManifestPath.isEmpty ? nil : try DesktopPetController(
            manifestPath: options.petManifestPath,
            sheetPath: options.petSheetPath,
            sequencePath: options.petSequencePath.isEmpty ? nil : options.petSequencePath,
            scale: options.petScale
        )
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let delegate = EdgeCompanionDelegate(options: options, image: image, desktopPet: desktopPet)
        app.delegate = delegate
        app.run()
    } catch {
        fputs("\(error.localizedDescription)\n", stderr)
        exit(2)
    }
}
