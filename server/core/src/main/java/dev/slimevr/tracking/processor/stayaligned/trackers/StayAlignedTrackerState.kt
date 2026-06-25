package dev.slimevr.tracking.processor.stayaligned.trackers

import dev.slimevr.math.Angle
import dev.slimevr.tracking.processor.stayaligned.StayAlignedDefaults
import dev.slimevr.tracking.processor.stayaligned.StayAlignedDefaults.RELOCK_YAW_THRESHOLD
import dev.slimevr.tracking.processor.stayaligned.adjust.LockedErrorVisitor
import dev.slimevr.tracking.trackers.Tracker
import io.github.axisangles.ktmath.Quaternion

class StayAlignedTrackerState(
	val tracker: Tracker,
) {
	// Whether to hide the yaw correction
	var hideCorrection = false

	// Detects whether the tracker is at rest
	val restDetector = StayAlignedDefaults.makeRestDetector()

	// Rotation of the tracker when it was locked
	var lockedRotation: Quaternion? = null

	// Yaw correction to apply to tracker rotation
	var yawCorrection = Angle.ZERO

	// Alignment error that yaw correction attempts to minimize
	var yawErrors = YawErrors()

	fun update() {
		restDetector.update(tracker.getRawRotation())
		when (restDetector.state) {
			RestDetector.State.AT_REST -> {
				val current = tracker.getAdjustedRotationForceStayAligned()
				val prev = lockedRotation
				// Re-lock when first locking, or when the tracker settled at a clearly
				// different yaw, which is a real pose change. Settling back near the same
				// yaw keeps the existing baseline so a brief shift does not bake in drift.
				if (prev == null || LockedErrorVisitor.yawFarFrom(current, prev, RELOCK_YAW_THRESHOLD)) {
					lockedRotation = current
				}
			}

			// Keep the baseline through brief movements so settling back after a small
			// shift re-locks to the original yaw instead of the drifted one
			RestDetector.State.RECENTLY_AT_REST -> {}

			RestDetector.State.MOVING -> {
				lockedRotation = null
			}
		}
	}

	fun reset() {
		restDetector.reset()
		lockedRotation = null
		yawCorrection = Angle.ZERO
		yawErrors = YawErrors()
	}
}
