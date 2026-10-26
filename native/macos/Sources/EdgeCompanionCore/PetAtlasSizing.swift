import CoreGraphics

public enum PetAtlasSizing {
    /// Keep only enough atlas pixels for the largest connected display scale
    /// and the selected presentation size. A small margin avoids resampling
    /// softness from fractional layer geometry without retaining a needlessly
    /// large decoded texture.
    public static func maximumPixelSize(
        sourceWidth: Int,
        sourceHeight: Int,
        columns: Int,
        rows: Int,
        logicalWidth: CGFloat,
        logicalHeight: CGFloat,
        presentationScale: CGFloat,
        backingScale: CGFloat,
        headroom: CGFloat = 1.05
    ) -> Int {
        guard sourceWidth > 0, sourceHeight > 0, columns > 0, rows > 0 else { return 1 }
        let sourceCellWidth = CGFloat(sourceWidth) / CGFloat(columns)
        let sourceCellHeight = CGFloat(sourceHeight) / CGFloat(rows)
        let requiredWidth = logicalWidth * presentationScale * backingScale
        let requiredHeight = logicalHeight * presentationScale * backingScale
        let ratio = min(1, max(requiredWidth / sourceCellWidth, requiredHeight / sourceCellHeight) * headroom)
        return max(1, Int(ceil(CGFloat(max(sourceWidth, sourceHeight)) * ratio)))
    }
}
