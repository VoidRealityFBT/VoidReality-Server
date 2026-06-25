package dev.slimevr.tracking.processor.stayaligned.adjust

import dev.slimevr.math.Angle
import dev.slimevr.tracking.processor.stayaligned.trackers.Side
import dev.slimevr.tracking.trackers.Tracker
import io.github.axisangles.ktmath.EulerOrder
import io.github.axisangles.ktmath.Vector3

/**
 * Utilities for tracker yaw.
 *
 * The SlimeVR coordinate system is x-right, y-up, z-back, which is a right-handed
 * coordinate system.
 *
 * Rotations follow the right-hand rule, for example, a positive rotation around the
 * y-axis is a counter-clockwise rotation from z to x. From the perspective of a player,
 * left is positive yaw, right is negative yaw.
 */
object TrackerYaw {

	/**
	 * Whether we can get the yaw of a tracker.
	 */
	fun hasTrackerYaw(tracker: Tracker) = Angle.absBetween(
		tracker.getAdjustedRotationForceStayAligned().sandwichUnitX(),
		Vector3.POS_Y,
	) > MIN_ON_SIDE_ANGLE

	/**
	 * Gets the yaw of the tracker about world up.
	 */
	fun trackerYaw(tracker: Tracker) = Angle.ofRad(
		tracker.getAdjustedRotationForceStayAligned().toEulerAngles(EulerOrder.YZX).y,
	)

	/**
	 * Applies an extra yaw in the specified direction.
	 */
	fun extraYaw(direction: Side, angle: Angle) = when (direction) {
		Side.LEFT -> angle
		Side.RIGHT -> -angle
	}

	private val MIN_ON_SIDE_ANGLE = Angle.ofDeg(30.0f)
}
