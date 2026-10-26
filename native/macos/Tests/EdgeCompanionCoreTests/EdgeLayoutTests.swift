import CoreGraphics
import XCTest
@testable import EdgeCompanionCore

final class EdgeLayoutTests: XCTestCase {
    func testPetAtlasKeepsDisplaySizedPixelsInsteadOfFullFourXSheet() {
        XCTAssertEqual(
            PetAtlasSizing.maximumPixelSize(
                sourceWidth: 3840,
                sourceHeight: 5720,
                columns: 8,
                rows: 11,
                logicalWidth: 192,
                logicalHeight: 208,
                presentationScale: 1.2,
                backingScale: 2
            ),
            5720
        )
        XCTAssertEqual(
            PetAtlasSizing.maximumPixelSize(
                sourceWidth: 6144,
                sourceHeight: 9152,
                columns: 8,
                rows: 11,
                logicalWidth: 192,
                logicalHeight: 208,
                presentationScale: 1.2,
                backingScale: 2
            ),
            5766
        )
        XCTAssertEqual(
            PetAtlasSizing.maximumPixelSize(
                sourceWidth: 6144,
                sourceHeight: 9152,
                columns: 8,
                rows: 11,
                logicalWidth: 192,
                logicalHeight: 208,
                presentationScale: 2.25,
                backingScale: 2
            ),
            9152
        )
    }

    func testDesktopPetFinalPositionStaysOnNearestDisplay() {
        let left = CGRect(x: 0, y: 0, width: 1280, height: 800)
        let right = CGRect(x: 1280, y: 0, width: 1728, height: 1080)

        let clippedLeft = DesktopPetPlacement.clamp(
            panelFrame: CGRect(x: -180, y: 120, width: 260, height: 300),
            to: [left, right]
        )
        XCTAssertEqual(clippedLeft.origin, CGPoint(x: 0, y: 120))

        let clippedRight = DesktopPetPlacement.clamp(
            panelFrame: CGRect(x: 2920, y: 900, width: 260, height: 300),
            to: [left, right]
        )
        XCTAssertEqual(clippedRight.origin, CGPoint(x: 2748, y: 780))
    }

    func testPanelStraddlesHostRightEdge() {
        let host = CGRect(x: 100, y: 80, width: 980, height: 720)
        let layout = EdgeLayout.place(hostFrame: host, insideWidth: 340, outsideWidth: 300)

        XCTAssertEqual(layout.panelFrame.maxX, host.maxX + 300, accuracy: 0.001)
        XCTAssertEqual(layout.panelFrame.minX + layout.hostEdgeX, host.maxX, accuracy: 0.001)
        XCTAssertEqual(layout.edgeLocation, 340.0 / 640.0, accuracy: 0.001)
        XCTAssertEqual(layout.panelFrame.minY, host.minY, accuracy: 0.001)
        XCTAssertEqual(layout.hostTopY, host.height, accuracy: 0.001)
    }

    func testMaximizedWindowContainsTheRightExtension() {
        let host = CGRect(x: 0, y: 24, width: 1440, height: 876)
        let layout = EdgeLayout.place(
            hostFrame: host,
            insideWidth: 340,
            outsideWidth: 300,
            containRightEdge: true
        )

        XCTAssertEqual(layout.panelFrame.maxX, host.maxX, accuracy: 0.001)
        XCTAssertEqual(layout.panelFrame.minX + layout.hostEdgeX, host.maxX, accuracy: 0.001)
        XCTAssertEqual(layout.hostEdgeX, layout.panelFrame.width, accuracy: 0.001)
        XCTAssertEqual(layout.effectiveOutsideWidth, 0, accuracy: 0.001)
    }

    func testRightEdgeTouchAloneIsNotMaximized() {
        let available = CGRect(x: 0, y: 24, width: 1440, height: 876)
        XCTAssertTrue(HostWindowState.isMaximized(hostFrame: available, candidateFrames: [available]))
        XCTAssertTrue(HostWindowState.isMaximized(
            hostFrame: available.insetBy(dx: 1, dy: 1),
            candidateFrames: [available]
        ))
        XCTAssertFalse(HostWindowState.isMaximized(
            hostFrame: CGRect(x: 440, y: 124, width: 1000, height: 700),
            candidateFrames: [available]
        ))
    }

    func testCharacterFollowsHostPastAFormerScreenBoundary() {
        let firstHost = CGRect(x: 500, y: 80, width: 980, height: 720)
        let movedHost = firstHost.offsetBy(dx: 260, dy: -140)
        let first = EdgeLayout.place(hostFrame: firstHost)
        let moved = EdgeLayout.place(hostFrame: movedHost)

        XCTAssertEqual(moved.panelFrame.origin.x - first.panelFrame.origin.x, 260, accuracy: 0.001)
        XCTAssertEqual(moved.panelFrame.origin.y - first.panelFrame.origin.y, -140, accuracy: 0.001)
        XCTAssertEqual(moved.panelFrame.size, first.panelFrame.size)
        XCTAssertEqual(moved.effectiveOutsideWidth, first.effectiveOutsideWidth, accuracy: 0.001)
        XCTAssertEqual(moved.panelFrame.minX + moved.hostEdgeX, movedHost.maxX, accuracy: 0.001)
    }

    func testEverySystemResizeEdgeStartsInteractionTracking() {
        let host = CGRect(x: 100, y: 80, width: 980, height: 720)

        XCTAssertTrue(HostInteractionRegion.contains(CGPoint(x: 76, y: 440), hostFrame: host))
        XCTAssertTrue(HostInteractionRegion.contains(CGPoint(x: 1104, y: 440), hostFrame: host))
        XCTAssertTrue(HostInteractionRegion.contains(CGPoint(x: 600, y: 56), hostFrame: host))
        XCTAssertTrue(HostInteractionRegion.contains(CGPoint(x: 600, y: 824), hostFrame: host))
        XCTAssertFalse(HostInteractionRegion.contains(CGPoint(x: 60, y: 440), hostFrame: host))
    }

    func testTopOverflowRemainsRigidlyAttachedToHost() {
        let floating = EdgeLayout.place(
            hostFrame: CGRect(x: 100, y: 80, width: 980, height: 600)
        )
        XCTAssertGreaterThan(floating.panelFrame.maxY, 680)
        XCTAssertEqual(floating.hostTopY, 600, accuracy: 0.001)

        let moved = EdgeLayout.place(
            hostFrame: CGRect(x: 100, y: 300, width: 980, height: 600)
        )
        XCTAssertEqual(moved.panelFrame.maxY - floating.panelFrame.maxY, 220, accuracy: 0.001)
        XCTAssertEqual(moved.panelFrame.height, floating.panelFrame.height, accuracy: 0.001)
        XCTAssertEqual(moved.hostTopY, floating.hostTopY, accuracy: 0.001)
    }

    func testNarrowWindowScalesCharacterAndKeepsLeftInside() {
        let host = CGRect(x: 100, y: 80, width: 500, height: 720)
        let layout = EdgeLayout.place(hostFrame: host)

        XCTAssertEqual(layout.scale, 0.68, accuracy: 0.001)
        XCTAssertGreaterThanOrEqual(layout.panelFrame.minX, host.minX)
        XCTAssertEqual(layout.panelFrame.minY, host.minY, accuracy: 0.001)
        XCTAssertLessThan(layout.panelFrame.height, host.height)
    }

    func testMaskOverlapsBothRightAndTopWindowSeams() {
        let hidden = EdgeMask.hiddenHostPath(
            bounds: CGRect(x: 0, y: 0, width: 640, height: 800),
            hostEdgeX: 340,
            hostTopY: 720,
            cornerRadius: 12,
            seamOverlap: 1.25
        )

        XCTAssertTrue(hidden.contains(CGPoint(x: 100, y: 100)))
        XCTAssertTrue(hidden.contains(CGPoint(x: 320, y: 360)))
        XCTAssertFalse(hidden.contains(CGPoint(x: 339.5, y: 360)))
        XCTAssertFalse(hidden.contains(CGPoint(x: 337, y: 1)))
        XCTAssertTrue(hidden.contains(CGPoint(x: 100, y: 718)))
        XCTAssertFalse(hidden.contains(CGPoint(x: 337, y: 719)))
        XCTAssertFalse(hidden.contains(CGPoint(x: 100, y: 719)))
    }

    func testQuartzToAppKitTransformIsContinuousAcrossDisplayDirections() {
        XCTAssertEqual(
            DesktopCoordinateSpace.appKitFrame(
                from: CGRect(x: -1440, y: 120, width: 900, height: 700),
                mainDisplayMaxY: 1080
            ),
            CGRect(x: -1440, y: 260, width: 900, height: 700)
        )
        XCTAssertEqual(
            DesktopCoordinateSpace.appKitFrame(
                from: CGRect(x: 1920, y: -900, width: 1200, height: 900),
                mainDisplayMaxY: 1080
            ),
            CGRect(x: 1920, y: 1080, width: 1200, height: 900)
        )
    }
}
