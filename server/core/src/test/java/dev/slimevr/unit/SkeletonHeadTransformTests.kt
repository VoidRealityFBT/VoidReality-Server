package dev.slimevr.unit

import com.jme3.math.FastMath
import dev.slimevr.tracking.processor.BoneType
import dev.slimevr.tracking.processor.HumanPoseManager
import io.github.axisangles.ktmath.EulerAngles
import io.github.axisangles.ktmath.EulerOrder
import io.github.axisangles.ktmath.Quaternion
import org.junit.jupiter.api.Test
import kotlin.math.abs

class SkeletonHeadTransformTests {

	/**
	 * The head bone is the root of the skeleton, so the whole spine hangs off its rotation.
	 * A past change rebased the head's pitch and roll onto a spine tracker's yaw, which leaned
	 * the torso forward and tilted the hips when turning the head. The head bone's rotation must
	 * depend only on the HMD, never on a spine tracker's yaw, otherwise turning your body (or a
	 * spine tracker drifting) swings the whole upper body.
	 */
	@Test
	fun testHeadBoneIndependentOfSpineYaw() {
		val trackers = TestTrackerSet()
		val hpm = HumanPoseManager(trackers.allL)

		// Head pitched down and turned to the side, held fixed for both samples.
		trackers.head.setRotation(
			EulerAngles(EulerOrder.YZX, -FastMath.QUARTER_PI, FastMath.QUARTER_PI, 0f).toQuaternion(),
		)

		// Sample 1: spine facing forward.
		setSpineYaw(trackers, 0f)
		hpm.update()
		val headWithSpineForward = hpm.getBone(BoneType.HEAD).getGlobalRotation()

		// Sample 2: same head, but the spine is turned 90 degrees.
		setSpineYaw(trackers, FastMath.HALF_PI)
		hpm.update()
		val headWithSpineTurned = hpm.getBone(BoneType.HEAD).getGlobalRotation()

		// Sign independent quaternion equality: |dot| ~= 1 means the same rotation.
		val dot = headWithSpineForward.x * headWithSpineTurned.x +
			headWithSpineForward.y * headWithSpineTurned.y +
			headWithSpineForward.z * headWithSpineTurned.z +
			headWithSpineForward.w * headWithSpineTurned.w
		assert(abs(dot) > 0.9999f) {
			"Head bone changed when only the spine yaw changed (<$headWithSpineForward> vs " +
				"<$headWithSpineTurned>). A spine tracker's yaw must not re-base the head bone, " +
				"that leans and tilts the whole body when turning the head."
		}
	}

	private fun setSpineYaw(trackers: TestTrackerSet, yaw: Float) {
		val rot = EulerAngles(EulerOrder.YZX, 0f, yaw, 0f).toQuaternion()
		trackers.chest.setRotation(rot)
		trackers.hip.setRotation(rot)
	}
}