import Foundation

/// Host activity survives local performances. The renderer owns frame timing;
/// this value owns which performance should be shown and what resumes after it.
public struct PetMotion: Equatable, Sendable {
    public private(set) var base = "idle"
    public private(set) var animation = "idle"
    public private(set) var dragging = false
    private var pendingCues: [String] = []
    private var recentEventIDs: [String] = []

    public init() {}

    public mutating func receive(base: String, cue: String? = nil, eventID: String? = nil) {
        guard ["idle", "running", "waiting"].contains(base) else { return }
        self.base = base
        if base != "idle" {
            pendingCues.removeAll { $0 == "review" }
            if animation == "review" { animation = base }
        }
        let newCue = cue.flatMap { ["failed", "review"].contains($0) ? $0 : nil }
        if let eventID, !eventID.isEmpty, !recentEventIDs.contains(eventID), let newCue {
            recentEventIDs.append(eventID)
            if recentEventIDs.count > 64 { recentEventIDs.removeFirst() }
            if newCue == "review", base != "idle" { return }
            if dragging || !["idle", "running", "waiting"].contains(animation) {
                pendingCues.append(newCue)
                if pendingCues.count > 16 { pendingCues.removeFirst() }
            }
            else { animation = newCue }
        } else if !dragging {
            if ["idle", "running", "waiting"].contains(animation) || (animation == "review" && base != "idle") {
                animation = base
            }
        }
    }

    public mutating func beginDrag(direction: String = "running-right") {
        dragging = true
        pendingCues.removeAll()
        animation = direction == "running-left" ? direction : "running-right"
    }

    public mutating func turn(left: Bool) {
        guard dragging else { return }
        animation = left ? "running-left" : "running-right"
    }

    public mutating func release() {
        dragging = false
        animation = nextCueOrBase()
    }

    public mutating func wave() {
        guard !dragging else { return }
        animation = "waving"
    }

    public mutating func finished() {
        guard !dragging else { return }
        animation = nextCueOrBase()
    }

    private mutating func nextCueOrBase() -> String {
        pendingCues.isEmpty ? base : pendingCues.removeFirst()
    }
}
