import CoreGraphics
import Foundation

public struct EdgeCompanionLayout: Equatable, Sendable {
    public let panelFrame: CGRect
    public let hostEdgeX: CGFloat
    public let hostTopY: CGFloat
    public let scale: CGFloat
    public let effectiveOutsideWidth: CGFloat

    public init(
        panelFrame: CGRect,
        hostEdgeX: CGFloat,
        hostTopY: CGFloat,
        scale: CGFloat,
        effectiveOutsideWidth: CGFloat
    ) {
        self.panelFrame = panelFrame
        self.hostEdgeX = hostEdgeX
        self.hostTopY = hostTopY
        self.scale = scale
        self.effectiveOutsideWidth = effectiveOutsideWidth
    }

    public var edgeLocation: CGFloat {
        guard panelFrame.width > 0 else { return 1 }
        return min(max(hostEdgeX / panelFrame.width, 0), 1)
    }
}
public enum EdgeLayout {
    /// Solves one character canvas in host-window coordinates. The screen is
    /// intentionally not an authority here: macOS may constrain, snap, ghost,
    /// or transfer the host between displays, but the two visible halves must
    /// remain one rigid image attached to the accepted host frame.
    public static func place(
        hostFrame: CGRect,
        insideWidth: CGFloat = 340,
        outsideWidth: CGFloat = 300,
        heightRatio: CGFloat = 1.08,
        maximumHeight: CGFloat = 900,
        shrinkThreshold: CGFloat = 960,
        minimumResponsiveScale: CGFloat = 0.68,
        containRightEdge: Bool = false
    ) -> EdgeCompanionLayout {
        let safeInside = max(insideWidth, 1)
        let safeOutside = max(outsideWidth, 0)
        let baseWidth = safeInside + safeOutside
        let baseHeight = max(1, min(hostFrame.height * max(heightRatio, 0.01), max(maximumHeight, 1)))

        let preferredScale = max(
            min(minimumResponsiveScale, 1),
            min(1, hostFrame.width / max(shrinkThreshold, 1))
        )
        let insideFit = hostFrame.width / safeInside
        let scale = max(0.01, min(1, preferredScale, insideFit))

        let width = baseWidth * scale
        let height = baseHeight * scale
        let effectiveOutside = containRightEdge ? 0 : safeOutside * scale
        let panelRight = hostFrame.maxX + effectiveOutside
        let hostEdgeX = containRightEdge ? width : safeInside * scale
        let frame = CGRect(
            x: panelRight - width,
            y: hostFrame.minY,
            width: width,
            height: height
        )
        return EdgeCompanionLayout(
            panelFrame: frame,
            hostEdgeX: hostEdgeX,
            hostTopY: min(height, max(0, hostFrame.height)),
            scale: scale,
            effectiveOutsideWidth: effectiveOutside
        )
    }
}

public enum HostWindowState {
    /// A right-edge touch alone can be a normal drag or macOS snap. Only a
    /// frame that owns every edge of one available screen area is maximized.
    public static func isMaximized(
        hostFrame: CGRect,
        candidateFrames: [CGRect],
        tolerance: CGFloat = 3
    ) -> Bool {
        guard hostFrame.width > 0, hostFrame.height > 0 else { return false }
        let margin = max(tolerance, 0)
        return candidateFrames.contains { candidate in
            candidate.width > 0 && candidate.height > 0 &&
                abs(hostFrame.minX - candidate.minX) <= margin &&
                abs(hostFrame.maxX - candidate.maxX) <= margin &&
                abs(hostFrame.minY - candidate.minY) <= margin &&
                abs(hostFrame.maxY - candidate.maxY) <= margin
        }
    }
}

public enum DesktopCoordinateSpace {
    /// Quartz window bounds use a top-left origin rooted at the main display,
    /// while AppKit global window coordinates use the main display's bottom.
    /// This single transform is continuous across displays in every direction;
    /// choosing one NSScreen first would introduce a discontinuity mid-drag.
    public static func appKitFrame(from quartzFrame: CGRect, mainDisplayMaxY: CGFloat) -> CGRect {
        CGRect(
            x: quartzFrame.minX,
            y: mainDisplayMaxY - quartzFrame.maxY,
            width: quartzFrame.width,
            height: quartzFrame.height
        )
    }
}

public enum HostInteractionRegion {
    /// macOS keeps part of a window's live-resize hit target just outside the
    /// reported frame. Include that system-owned area so every edge starts the
    /// same short-lived high-frequency geometry tracking path.
    public static func contains(
        _ point: CGPoint,
        hostFrame: CGRect,
        tolerance: CGFloat = 24
    ) -> Bool {
        let region = hostFrame.insetBy(dx: -max(tolerance, 0), dy: -max(tolerance, 0))
        return point.x >= region.minX && point.x <= region.maxX &&
            point.y >= region.minY && point.y <= region.maxY
    }
}

public enum DesktopPetPlacement {
    /// Keeps a desktop pet recoverable after a drag without tying it to any
    /// application window. The nearest display owns the final position and the
    /// full transparent pet canvas remains inside that display's visible area.
    public static func clamp(panelFrame: CGRect, to visibleFrames: [CGRect]) -> CGRect {
        guard !visibleFrames.isEmpty else { return panelFrame }
        let target = visibleFrames.max { left, right in
            let leftArea = intersectionArea(panelFrame, left)
            let rightArea = intersectionArea(panelFrame, right)
            if leftArea != rightArea { return leftArea < rightArea }
            return distance(panelFrame, left) > distance(panelFrame, right)
        } ?? visibleFrames[0]
        let maximumX = max(target.minX, target.maxX - panelFrame.width)
        let maximumY = max(target.minY, target.maxY - panelFrame.height)
        return CGRect(
            x: min(max(panelFrame.minX, target.minX), maximumX),
            y: min(max(panelFrame.minY, target.minY), maximumY),
            width: panelFrame.width,
            height: panelFrame.height
        )
    }

    private static func intersectionArea(_ left: CGRect, _ right: CGRect) -> CGFloat {
        let intersection = left.intersection(right)
        guard !intersection.isNull else { return 0 }
        return intersection.width * intersection.height
    }

    private static func distance(_ left: CGRect, _ right: CGRect) -> CGFloat {
        let dx = max(max(left.minX - right.maxX, right.minX - left.maxX), 0)
        let dy = max(max(left.minY - right.maxY, right.minY - left.maxY), 0)
        return hypot(dx, dy)
    }
}

public enum EdgeMask {
    public static func hiddenHostPath(
        bounds: CGRect,
        hostEdgeX: CGFloat,
        hostTopY: CGFloat,
        cornerRadius: CGFloat,
        seamOverlap: CGFloat
    ) -> CGPath {
        let overlap = max(seamOverlap, 0)
        let maximumX = min(max(hostEdgeX - overlap, 0), bounds.width)
        let maximumY = min(max(hostTopY - overlap, 0), bounds.height)
        let radius = min(max(cornerRadius, 0), maximumX, maximumY / 2)
        let path = CGMutablePath()
        guard maximumX > 0, maximumY > 0 else { return path }
        path.move(to: CGPoint(x: 0, y: 0))
        path.addLine(to: CGPoint(x: maximumX - radius, y: 0))
        if radius > 0 {
            path.addArc(
                center: CGPoint(x: maximumX - radius, y: radius),
                radius: radius,
                startAngle: -.pi / 2,
                endAngle: 0,
                clockwise: false
            )
        }
        path.addLine(to: CGPoint(x: maximumX, y: maximumY - radius))
        if radius > 0 {
            path.addArc(
                center: CGPoint(x: maximumX - radius, y: maximumY - radius),
                radius: radius,
                startAngle: 0,
                endAngle: .pi / 2,
                clockwise: false
            )
        }
        path.addLine(to: CGPoint(x: 0, y: maximumY))
        path.closeSubpath()
        return path
    }
}
