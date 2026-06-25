package dev.slimevr.config

import com.fasterxml.jackson.annotation.JsonIgnore

class StayAlignedConfig {

	/**
	 * Apply yaw correction
	 */
	var enabled = false

	/**
	 * Temporarily hide the yaw correction from Stay Aligned.
	 *
	 * Players can enable this to compare to when Stay Aligned is not enabled. Useful to
	 * verify if Stay Aligned improved the situation. Also useful to prevent players
	 * from saying "Stay Aligned screwed up my trackers!!" when it's actually a tracker
	 * that is drifting extremely badly.
	 *
	 * Do not serialize to config so that when the server restarts, it is always false.
	 */
	@JsonIgnore
	var hideYawCorrection = false

	/**
	 * Standing relaxed pose
	 */
	val standingRelaxedPose = StayAlignedRelaxedPoseConfig()

	/**
	 * Sitting relaxed pose
	 */
	val sittingRelaxedPose = StayAlignedRelaxedPoseConfig()

	/**
	 * Flat relaxed pose
	 */
	val flatRelaxedPose = StayAlignedRelaxedPoseConfig()

	/**
	 * Whether setup has been completed
	 */
	var setupComplete = false

	/**
	 * Pause the centering force unless the player is clearly upright (standing or sitting).
	 *
	 * In any other pose(lying on the back, on the side, on the stomach, slanted, kneeling,
	 * legs in the air, or an unrecognized pose), the legs are often horizontal, where yaw
	 * about vertical is degenerate. There the centering force pulls them toward a wrong (often
	 * standing) shape and crosses the legs. The locked anti drift force still runs, so trackers
	 * at rest are still held in place and the body does not drift.
	 */
	var pauseCenteringWhenNotUpright = true
}
