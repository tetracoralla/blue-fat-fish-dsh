import XCTest
@testable import EdgeCompanionCore

final class PetMotionTests: XCTestCase {
    func testWaitingResolutionAndLocalInteractionResumeCurrentWork() {
        var motion = PetMotion()
        motion.receive(base: "running")
        motion.receive(base: "waiting")
        XCTAssertEqual(motion.animation, "waiting")
        motion.receive(base: "running")
        XCTAssertEqual(motion.animation, "running")
        motion.wave()
        XCTAssertEqual(motion.animation, "waving")
        motion.finished()
        XCTAssertEqual(motion.animation, "running")
        motion.beginDrag()
        motion.receive(base: "waiting")
        motion.turn(left: true)
        XCTAssertEqual(motion.animation, "running-left")
        motion.release()
        XCTAssertEqual(motion.animation, "waiting")
    }

    func testLatestEventDuringDragIsShownOnceThenReturnsToCurrentBase() {
        var motion = PetMotion()
        motion.receive(base: "running")
        motion.beginDrag()
        motion.receive(base: "idle", cue: "failed", eventID: "failure-1")
        XCTAssertEqual(motion.animation, "running-right")
        motion.release()
        XCTAssertEqual(motion.animation, "failed")
        motion.finished()
        XCTAssertEqual(motion.animation, "idle")
        motion.receive(base: "running", cue: "failed", eventID: "failure-1")
        XCTAssertEqual(motion.animation, "running")
        motion.receive(base: "running", cue: "failed", eventID: "failure-2")
        XCTAssertEqual(motion.animation, "failed")
    }

    func testNewWorkCancelsObsoleteReviewAndInvalidBaseCannotChangeState() {
        var motion = PetMotion()
        motion.receive(base: "idle", cue: "review", eventID: "done-1")
        motion.receive(base: "running")
        XCTAssertEqual(motion.animation, "running")
        motion.beginDrag()
        motion.receive(base: "idle", cue: "review", eventID: "done-2")
        motion.receive(base: "running")
        motion.release()
        XCTAssertEqual(motion.animation, "running")
        let previous = motion
        motion.receive(base: "bad-state", cue: "failed", eventID: "bad")
        XCTAssertEqual(motion, previous)
    }

    func testBackToBackMatchingCuesAreQueuedInsteadOfLost() {
        var motion = PetMotion()
        motion.receive(base: "running", cue: "failed", eventID: "failure-1")
        XCTAssertEqual(motion.animation, "failed")
        motion.receive(base: "running", cue: "failed", eventID: "failure-2")
        motion.finished()
        XCTAssertEqual(motion.animation, "failed")
        motion.finished()
        XCTAssertEqual(motion.animation, "running")
    }

    func testThreeMatchingCuesRemainFIFOAndDuplicateEventIsIgnored() {
        var motion = PetMotion()
        motion.receive(base: "running", cue: "failed", eventID: "failure-1")
        motion.receive(base: "running", cue: "failed", eventID: "failure-2")
        motion.receive(base: "running", cue: "failed", eventID: "failure-3")
        motion.receive(base: "running", cue: "failed", eventID: "failure-2")
        XCTAssertEqual(motion.animation, "failed")
        motion.finished()
        XCTAssertEqual(motion.animation, "failed")
        motion.finished()
        XCTAssertEqual(motion.animation, "failed")
        motion.finished()
        XCTAssertEqual(motion.animation, "running")
    }
}
