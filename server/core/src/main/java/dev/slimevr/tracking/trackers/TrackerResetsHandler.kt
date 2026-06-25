package dev.slimevr.tracking.trackers

import com.jme3.math.FastMath
import dev.slimevr.VRServer
import dev.slimevr.config.ArmsResetModes
import dev.slimevr.config.DriftCompensationConfig
import dev.slimevr.config.ResetsConfig
import dev.slimevr.filtering.CircularArrayList
import dev.slimevr.tracking.trackers.udp.TrackerDataType
import io.eiren.util.logging.LogManager
import io.github.axisangles.ktmath.EulerAngles
import io.github.axisangles.ktmath.EulerOrder
import io.github.axisangles.ktmath.Quaternion
import io.github.axisangles.ktmath.Vector3
import java.util.Locale
import kotlin.math.*

private const val DRIFT_COOLDOWN_MS = 50000L

// resets closer together than this give too noisy a drift measurement
private const val DRIFT_MEASURE_MIN_MS = 60000L

// intervals longer than this are not trusted: a fast tracker can drift more than 180 degrees of
// yaw over a long gap, which wraps to the shortest angle and under reports the rate, so we skip
// learning from it rather than poison the estimate with a too low number
private const val DRIFT_MEASURE_MAX_MS = 900000L

// EMA weight for blending each reset's measured drift rate into the running estimate. One
// noisy interval moves the estimate by only this fraction, so a single bad sample cannot
// capture it; over several resets the estimate settles on the tracker's real behavior.
private const val DRIFT_RATE_EMA_ALPHA = 0.3f

// Once an estimate is established, a sample both this many times larger than it and this many
// deg/min above it is treated as a physical disturbance (the tracker slipped on the limb, was
// pulled back up the thigh, or was knocked) rather than gyro drift, and is not learned from.
// Drift is a property of the sensor, not where it sits, so a reposition must not poison it.
private const val DRIFT_RATE_OUTLIER_FACTOR = 4f
private const val DRIFT_RATE_OUTLIER_MIN_ABS_DEG_PER_MIN = 5f

// A slip is a one off event; big samples that keep coming are real fast drift (a hot tracker
// genuinely drifts that hard). After this many big samples in a row we stop treating them as
// slips and let the estimate climb to the truth, so a fast tracker is not stuck reporting low.
private const val DRIFT_RATE_MAX_CONSECUTIVE_SLIPS = 2

// Temperature binned drift model. Gyro bias, the source of yaw drift, shifts with IMU
// temperature, so drift rate is learned as a function of temperature: each ~2 C bin holds an
// EMA of the rate measured there. Prediction reads the bin for the current temperature, which
// lets a warming tracker be corrected for its learned warm up drift instead of waiting for
// resets to remeasure it. Samples outside the range are clamped into the end bins.
private const val DRIFT_TEMP_BIN_WIDTH_C = 2f
private const val DRIFT_TEMP_MIN_C = 10f
private const val DRIFT_TEMP_MAX_C = 50f
private const val DRIFT_TEMP_BIN_MIN_SAMPLES = 1

/** Class taking care of full reset, yaw reset, mounting reset, and drift compensation logic. */
class TrackerResetsHandler(val tracker: Tracker) {

	private val HalfHorizontal = EulerAngles(
		EulerOrder.YZX,
		0f,
		Math.PI.toFloat(),
		0f,
	).toQuaternion()
	private var driftAmount = 0f
	private var averagedDriftQuat = Quaternion.IDENTITY
	private var rotationSinceReset = Quaternion.IDENTITY
	private var driftQuats = CircularArrayList<Quaternion>(0)
	private var driftTimes = CircularArrayList<Long>(0)
	private var totalDriftTime: Long = 0
	private var driftSince: Long = 0
	private var timeAtLastReset: Long = 0
	private var compensateDrift = false
	private var driftPrediction = false
	private var driftCompensationEnabled = false
	private var armsResetMode = ArmsResetModes.BACK
	private var yawResetSmoothTime = 0.0f
	var saveMountingReset = false
	var resetHmdPitch = false
	var allowDriftCompensation = false
	var lastResetQuaternion: Quaternion? = null

	// last measured yaw drift rate in degrees per minute, for logging and diagnostics
	var measuredDriftRateDegPerMin = 0f
		private set

	// consecutive big "slip looking" samples; lets a genuinely fast tracker recover instead of
	// every high sample being rejected as a slip forever (see measureDrift)
	private var consecutiveSlipSamples = 0

	// time of the last drift measurement, independent of drift compensation
	private var driftMeasureSince = 0L

	// IMU temperature at the start of the current drift measurement interval, so the measured
	// rate can be attributed to the interval's average temperature in the model below
	private var driftMeasureStartTemp: Float? = null

	private val tempDriftModel = TempDriftModel()

	/**
	 * Per tracker learned map of yaw drift rate (deg/min) against IMU temperature. Each bin
	 * holds an EMA of the rate measured at that temperature plus a sample count, so prediction
	 * can give a cold or warming tracker its learned drift rate for the temperature it is at.
	 */
	private class TempDriftModel {
		private val binCount =
			((DRIFT_TEMP_MAX_C - DRIFT_TEMP_MIN_C) / DRIFT_TEMP_BIN_WIDTH_C).toInt() + 1
		private val rate = FloatArray(binCount)
		private val count = IntArray(binCount)

		private fun indexFor(tempC: Float): Int =
			((tempC - DRIFT_TEMP_MIN_C) / DRIFT_TEMP_BIN_WIDTH_C).toInt().coerceIn(0, binCount - 1)

		fun record(tempC: Float, sampleRate: Float) {
			val i = indexFor(tempC)
			rate[i] = if (count[i] == 0) {
				sampleRate
			} else {
				rate[i] + (sampleRate - rate[i]) * DRIFT_RATE_EMA_ALPHA
			}
			count[i]++
		}

		// The learned rate for this temperature, or the nearest populated bin's rate, or null
		// when nothing has been learned yet (caller then falls back to the measured scalar).
		fun predict(tempC: Float): Float? {
			val center = indexFor(tempC)
			var offset = 0
			while (center - offset >= 0 || center + offset < binCount) {
				val lo = center - offset
				val hi = center + offset
				if (lo >= 0 && count[lo] >= DRIFT_TEMP_BIN_MIN_SAMPLES) return rate[lo]
				if (hi < binCount && count[hi] >= DRIFT_TEMP_BIN_MIN_SAMPLES) return rate[hi]
				offset++
			}
			return null
		}

		private fun binCenter(i: Int): Float =
			DRIFT_TEMP_MIN_C + (i + 0.5f) * DRIFT_TEMP_BIN_WIDTH_C

		// Populated bins as a map of bin center temperature to rate, for persistence. Keyed by
		// temperature rather than bin index so the saved curve survives a change of bin layout.
		fun export(): Map<String, Float> {
			val out = HashMap<String, Float>()
			for (i in 0 until binCount) {
				if (count[i] > 0) out[String.format(Locale.ROOT, "%.1f", binCenter(i))] = rate[i]
			}
			return out
		}

		// Restores a saved curve, re-binning by temperature. Loaded bins count as established so
		// later samples blend into them rather than overwriting the learned value.
		fun import(bins: Map<String, Float>) {
			for ((tempStr, r) in bins) {
				val t = tempStr.toFloatOrNull() ?: continue
				val i = indexFor(t)
				rate[i] = r
				if (count[i] < 1) count[i] = 1
			}
		}
	}

	/** Populated drift-versus-temperature bins for persistence (bin center C to deg/min). */
	fun exportDriftModel(): Map<String, Float> = tempDriftModel.export()

	/** Loads a persisted drift-versus-temperature curve learned in a previous session. */
	fun importDriftModel(bins: Map<String, Float>?) {
		if (bins != null) tempDriftModel.import(bins)
	}

	/**
	 * Drift rate to drive correction with: the temperature model's prediction for the current
	 * IMU temperature when it has learned something, otherwise the smoothed measured rate. Same
	 * units and meaning as "measuredDriftRateDegPerMin", so Stay Aligned consumes it unchanged.
	 */
	fun predictedDriftRateDegPerMin(): Float {
		val temp = tracker.temperature
		if (temp != null) {
			tempDriftModel.predict(temp)?.let { return it }
		}
		return measuredDriftRateDegPerMin
	}

	private fun averageTemp(a: Float?, b: Float?): Float? = when {
		a != null && b != null -> (a + b) / 2f
		a != null -> a
		b != null -> b
		else -> null
	}

	// Manual mounting orientation
	var mountingOrientation = HalfHorizontal
		set(value) {
			field = value
			// Clear the mounting reset now that it's been set manually
			clearMounting()
		}

	// Reference adjustment quats

	/**
	 * Gyro fix is set by full reset. This sets the current y rotation to 0, correcting
	 * for initial yaw rotation and the rotation incurred by mounting orientation. This
	 * is a local offset in rotation and does not affect the axes of rotation.
	 *
	 * This rotation is only used to compute [attachmentFix], otherwise [yawFix] would
	 * correct for the same rotation.
	 */
	private var gyroFix = Quaternion.IDENTITY

	/**
	 * Attachment fix is set by full reset. This sets the current x and z rotations to
	 * 0, correcting for initial pitch and roll rotation. This is a global offset in
	 * rotation and affects the axes of rotation.
	 *
	 * This effectively sets the rotation at the moment of a full reset to be
	 * zero-reference in the x and z axes.
	 */
	private var attachmentFix = Quaternion.IDENTITY

	/**
	 * Mounting rotation fix is set by mounting reset. This corrects for the mounting
	 * orientation, then the inverse is used to correct for the rotation incurred. This
	 * value is computed after [yawFix], but takes effect before [yawFix]. This affects
	 * the axes of rotation, but does not incur an offset in rotation.
	 *
	 * This rotation is done in addition to [mountingOrientation] as to not interfere
	 * with the functionality of manual mounting orientation. This effectively sets the
	 * rotation at the moment of a mounting reset to be zero-reference in the y-axis. If
	 * no mounting reset is done, then this rotation will not be used and only
	 * [mountingOrientation] will apply.
	 */
	var mountRotFix = Quaternion.IDENTITY
		private set

	/**
	 * Yaw fix is set by yaw reset. This sets the current y rotation to match the
	 * provided reference, correlating the tracker to the provided frame of reference.
	 * This is a local offset in rotation and does not affect the axes of rotation.
	 *
	 * This effectively aligns the current yaw rotation to the head tracker's yaw
	 * rotation.
	 */
	private var yawFix = Quaternion.IDENTITY

	/**
	 * Constraint fix is set by skeleton constraints. This corrects for any yaw rotation
	 * that violates the skeleton constraints. This is a local offset in rotation and
	 * does not affect the axes of rotation.
	 */
	private var constraintFix = Quaternion.IDENTITY

	// Zero-reference/identity adjustment quats for IMU debugging
	private var gyroFixNoMounting = Quaternion.IDENTITY
	private var attachmentFixNoMounting = Quaternion.IDENTITY
	private var yawFixZeroReference = Quaternion.IDENTITY

	/**
	 * T-Pose down fix is set by full reset. This corrects for the pitch of the rotation
	 * assuming a t-pose reference, adjusting to match our expected i-pose reference.
	 * This is a global offset in rotation and affects the axes of rotation.
	 */
	private var tposeDownFix = Quaternion.IDENTITY

	/**
	 * Reads/loads drift compensation settings from given config
	 */
	fun readDriftCompensationConfig(config: DriftCompensationConfig) {
		// was hardcoded false which left the GUI toggle dead and drift compensation never ran
		compensateDrift = config.enabled
		driftPrediction = config.prediction
		driftAmount = config.amount
		val maxResets = config.maxResets

		if (compensateDrift && maxResets != driftQuats.capacity()) {
			driftQuats = CircularArrayList<Quaternion>(maxResets)
			driftTimes = CircularArrayList<Long>(maxResets)
		}

		refreshDriftCompensationEnabled()
	}

	/**
	 * Clears drift compensation data
	 */
	fun clearDriftCompensation() {
		driftSince = 0L
		timeAtLastReset = 0L
		totalDriftTime = 0L
		driftQuats.clear()
		driftTimes.clear()
	}

	/**
	 * Checks for compensateDrift, allowDriftCompensation, and if
	 * a computed head tracker exists.
	 */
	fun refreshDriftCompensationEnabled() {
		driftCompensationEnabled = compensateDrift &&
			allowDriftCompensation &&
			TrackerUtils.getNonInternalNonImuTrackerForBodyPosition(
				VRServer.instance.allTrackers,
				TrackerPosition.HEAD,
			) != null
	}

	/**
	 * Reads/loads reset settings from the given config
	 */
	fun readResetConfig(config: ResetsConfig) {
		armsResetMode = config.mode
		yawResetSmoothTime = config.yawResetSmoothTime
		saveMountingReset = config.saveMountingReset
		resetHmdPitch = config.resetHmdPitch
	}

	fun trySetMountingReset(quat: Quaternion) {
		if (saveMountingReset) {
			mountRotFix = quat
		}
	}

	/**
	 * Takes a rotation and adjusts it to resets, mounting,
	 * and drift compensation, with the HMD as the reference.
	 */
	fun getReferenceAdjustedDriftRotationFrom(rotation: Quaternion): Quaternion = adjustToDrift(adjustToReference(rotation))

	/**
	 * Takes a rotation and adjusts it to resets and mounting,
	 * with the identity Quaternion as the reference.
	 */
	fun getIdentityAdjustedDriftRotationFrom(rotation: Quaternion): Quaternion = adjustToDrift(adjustToIdentity(rotation))

	/**
	 * Get the reference adjusted accel.
	 */
	// Rotate the local vector to world space, then align its heading to the reset
	// reference with a yaw only correction so the vertical component stays intact. The
	// previous version did no heading correction so the output had an arbitrary yaw.
	fun getReferenceAdjustedAccel(rawRot: Quaternion, accel: Vector3): Vector3 {
		val headingCorrection = getYawQuaternion(adjustToReference(rawRot)) * getYawQuaternion(rawRot).inv()
		return (headingCorrection * rawRot).sandwich(accel)
	}

	/**
	 * Transforms a measured angular velocity from the raw tracker body frame into the
	 * reference adjusted body frame, so it matches the rotation the filter sees. Only the
	 * body side (right multiplied) factors of adjustToReference rotate a body-frame rate;
	 * the heading corrections, Stay Aligned and drift compensation are all world side and
	 * leave it unchanged. Mirrors the body side of adjustToReference exactly.
	 */
	fun adjustAngularVelocityToReference(angularVelocity: Vector3): Vector3 {
		var bodyFrame = Quaternion.IDENTITY
		if (!tracker.isHmd || tracker.trackerPosition != TrackerPosition.HEAD) {
			bodyFrame *= mountingOrientation
		}
		bodyFrame *= attachmentFix
		bodyFrame *= mountRotFix
		bodyFrame *= tposeDownFix
		return bodyFrame.inv().sandwich(angularVelocity)
	}

	/**
	 * Converts raw or filtered rotation into reference- and
	 * mounting-reset-adjusted by applying quaternions produced after
	 * full reset, yaw rest and mounting reset
	 */
	private fun adjustToReference(rotation: Quaternion): Quaternion {
		var rot = rotation
		// Align heading axis with bone space
		if (!tracker.isHmd || tracker.trackerPosition != TrackerPosition.HEAD) {
			rot *= mountingOrientation
		}
		// Heading correction assuming manual orientation is correct
		rot = gyroFix * rot
		// Align attitude axes with bone space
		rot *= attachmentFix
		// Secondary heading axis alignment with bone space for automatic mounting
		// Note: Applying an inverse amount of heading correction corresponding to the
		//  axis alignment quaternion will leave the correction to another variable
		rot = mountRotFix.inv() * (rot * mountRotFix)
		// More attitude axes alignment specifically for the t-pose configuration, this
		//  probably shouldn't be a separate variable from attachmentFix?
		rot *= tposeDownFix
		// More heading correction
		rot = yawFix * rot
		rot = constraintFix * rot
		return rot
	}

	/**
	 * Converts raw or filtered rotation into zero-reference-adjusted by
	 * applying quaternions produced after full reset and yaw reset only
	 */
	// This is essentially just adjustToReference but aligning to quaternion identity
	//  rather than to the bone.
	private fun adjustToIdentity(rotation: Quaternion): Quaternion {
		var rot = rotation
		rot = gyroFixNoMounting * rot
		rot *= attachmentFixNoMounting
		rot = yawFixZeroReference * rot
		rot = constraintFix * rot
		return rot
	}

	/**
	 * Adjust the given rotation for drift compensation if enabled,
	 * and returns it
	 */
	private fun adjustToDrift(rotation: Quaternion): Quaternion {
		if (driftCompensationEnabled && totalDriftTime > 0) {
			var driftTimeRatio = ((System.currentTimeMillis() - driftSince).toFloat() / totalDriftTime)
			if (!driftPrediction) {
				driftTimeRatio = min(1.0f, driftTimeRatio)
			}
			return averagedDriftQuat.pow(driftAmount * driftTimeRatio) * rotation
		}
		return rotation
	}

	/**
	 * Reset the tracker so that its current rotation is counted as (0, HMD Yaw,
	 * 0). This allows the tracker to be strapped to body at any pitch and roll.
	 */
	fun resetFull(reference: Quaternion) {
		constraintFix = Quaternion.IDENTITY

		if (tracker.trackerDataType == TrackerDataType.FLEX_RESISTANCE) {
			tracker.trackerFlexHandler.resetMin()
			postProcessResetFull(reference)
			return
		} else if (tracker.trackerDataType == TrackerDataType.FLEX_ANGLE) {
			postProcessResetFull(reference)
			return
		}

		// Adjust for T-Pose (down)
		tposeDownFix = if (((tracker.trackerPosition.isLeftArm() || tracker.trackerPosition.isLeftFinger()) && armsResetMode == ArmsResetModes.TPOSE_DOWN)) {
			EulerAngles(EulerOrder.YZX, 0f, 0f, -FastMath.HALF_PI).toQuaternion()
		} else if (((tracker.trackerPosition.isRightArm() || tracker.trackerPosition.isRightFinger()) && armsResetMode == ArmsResetModes.TPOSE_DOWN)) {
			EulerAngles(EulerOrder.YZX, 0f, 0f, FastMath.HALF_PI).toQuaternion()
		} else {
			Quaternion.IDENTITY
		}

		// Old rot for drift compensation
		val oldRot = adjustToReference(tracker.getRawRotation())
		lastResetQuaternion = oldRot

		// Adjust raw rotation to mountingOrientation
		val mountingAdjustedRotation = tracker.getRawRotation() * mountingOrientation

		// Gyrofix
		if (tracker.allowMounting || (tracker.trackerPosition == TrackerPosition.HEAD && !tracker.isHmd)) {
			gyroFix = if (tracker.isComputed) {
				fixGyroscope(tracker.getRawRotation())
			} else {
				fixGyroscope(mountingAdjustedRotation * tposeDownFix)
			}
		}

		// Mounting for computed trackers
		if (tracker.isComputed && tracker.trackerPosition != TrackerPosition.HEAD) {
			// Set mounting to the reference's yaw so that a computed
			// tracker goes forward according to the head tracker.
			mountRotFix = getYawQuaternion(reference)
		}

		// Attachment fix
		attachmentFix = if (tracker.trackerPosition == TrackerPosition.HEAD && tracker.isHmd) {
			if (resetHmdPitch) {
				// Reset the HMD's pitch if it's assigned to head and resetHmdPitch is true
				// Get rotation without yaw (make sure to use the raw rotation directly!)
				val rotBuf = getYawQuaternion(tracker.getRawRotation()).inv() * tracker.getRawRotation()
				// Isolate pitch
				Quaternion(rotBuf.w, -rotBuf.x, 0f, 0f).unit()
			} else {
				// Don't reset the HMD at all
				Quaternion.IDENTITY
			}
		} else {
			fixAttachment(mountingAdjustedRotation)
		}

		// Rotate attachmentFix by 180 degrees as a workaround for t-pose (down)
		if (tposeDownFix != Quaternion.IDENTITY && tracker.allowMounting) {
			attachmentFix *= HalfHorizontal
		}

		makeIdentityAdjustmentQuatsFull()

		// Don't adjust yaw if head and computed
		if (tracker.trackerPosition != TrackerPosition.HEAD || !tracker.isComputed) {
			yawFix = fixYaw(mountingAdjustedRotation, reference)
			tracker.yawResetSmoothing.reset()
		}

		measureDrift(oldRot)
		calculateDrift(oldRot)

		// Reset Stay Aligned (before resetting filtering, which depends on the
		// tracker's rotation)
		tracker.stayAligned.reset()

		postProcessResetFull(reference)
	}

	private fun postProcessResetFull(reference: Quaternion) {
		if (this.tracker.needReset) {
			this.tracker.needReset = false
		}

		tracker.resetFilteringQuats(reference)
	}

	/**
	 * Reset the tracker so that its current yaw rotation is aligned with the HMD's
	 * Yaw. This allows the tracker to have yaw independent of the HMD. Tracker
	 * should still report yaw as if it was mounted facing HMD, mounting
	 * position should be corrected in the source.
	 */
	fun resetYaw(reference: Quaternion) {
		// TODO HMD doesn't get yaw reset, which makes it so tracker.resetFilteringQuats() doesn't get called

		constraintFix = Quaternion.IDENTITY

		if (tracker.trackerDataType == TrackerDataType.FLEX_RESISTANCE ||
			tracker.trackerDataType == TrackerDataType.FLEX_ANGLE
		) {
			// Don't do anything as these don't have yaw anyways
			return
		}

		// Old rot for drift compensation
		val oldRot = adjustToReference(tracker.getRawRotation())
		lastResetQuaternion = oldRot

		val yawFixOld = yawFix
		yawFix = fixYaw(tracker.getRawRotation() * mountingOrientation, reference)
		tracker.yawResetSmoothing.reset()

		makeIdentityAdjustmentQuatsYaw()

		measureDrift(oldRot)
		calculateDrift(oldRot)

		// Start at yaw before reset if smoothing enabled
		if (yawResetSmoothTime > 0.0f) {
			tracker.yawResetSmoothing.interpolate(
				yawFixOld / yawFix,
				Quaternion.IDENTITY,
				yawResetSmoothTime,
			)
		}

		// Reset Stay Aligned (before resetting filtering, which depends on the
		// tracker's rotation)
		tracker.stayAligned.reset()

		tracker.resetFilteringQuats(reference)
	}

	/**
	 * Perform the math to align the tracker to go forward
	 * and stores it in mountRotFix, and adjusts yawFix
	 */
	fun resetMounting(reference: Quaternion) {
		if (tracker.trackerDataType == TrackerDataType.FLEX_RESISTANCE) {
			tracker.trackerFlexHandler.resetMax()
			tracker.resetFilteringQuats(reference)
			return
		} else if (tracker.trackerDataType == TrackerDataType.FLEX_ANGLE) {
			return
		}

		constraintFix = Quaternion.IDENTITY

		// Get the current calibrated rotation
		var rotBuf = adjustToDrift(tracker.getRawRotation() * mountingOrientation)
		rotBuf = gyroFix * rotBuf
		rotBuf *= attachmentFix
		rotBuf = yawFix * rotBuf

		// Adjust buffer to reference
		rotBuf = reference.project(Vector3.POS_Y).inv().unit() * rotBuf

		// Rotate a vector pointing up by the quat
		val rotVector = rotBuf.sandwich(Vector3.POS_Y)

		// Calculate the yaw angle using tan
		var yawAngle = atan2(rotVector.x, rotVector.z)

		// Adjust for T-Pose and fingers
		if ((tracker.trackerPosition.isLeftArm() && armsResetMode == ArmsResetModes.TPOSE_DOWN) ||
			(tracker.trackerPosition.isRightArm() && armsResetMode == ArmsResetModes.TPOSE_UP) ||
			tracker.trackerPosition.isLeftFinger()
		) {
			// Tracker goes right
			yawAngle -= FastMath.HALF_PI
		}
		if ((tracker.trackerPosition.isLeftArm() && armsResetMode == ArmsResetModes.TPOSE_UP) ||
			(tracker.trackerPosition.isRightArm() && armsResetMode == ArmsResetModes.TPOSE_DOWN) ||
			tracker.trackerPosition.isRightFinger()
		) {
			// Tracker goes left
			yawAngle += FastMath.HALF_PI
		}

		// Adjust for forward/back arms and thighs
		val isLowerArmBack = armsResetMode == ArmsResetModes.BACK && (tracker.trackerPosition.isLeftLowerArm() || tracker.trackerPosition.isRightLowerArm())
		val isArmForward = armsResetMode == ArmsResetModes.FORWARD && (tracker.trackerPosition.isLeftArm() || tracker.trackerPosition.isRightArm())
		if (!tracker.trackerPosition.isThigh() && !isArmForward && !isLowerArmBack) {
			// Tracker goes back
			yawAngle -= FastMath.PI
		}

		// Make an adjustment quaternion from the angle
		mountRotFix = EulerAngles(EulerOrder.YZX, 0f, yawAngle, 0f).toQuaternion()

		// save mounting reset
		if (saveMountingReset) tracker.saveMountingResetOrientation(mountRotFix)

		tracker.resetFilteringQuats(reference)
	}

	/**
	 * Apply a corrective rotation to the gyroFix
	 */
	fun updateConstraintFix(correctedRotation: Quaternion) {
		constraintFix *= correctedRotation
	}

	fun clearMounting() {
		mountRotFix = Quaternion.IDENTITY
	}

	private fun fixGyroscope(sensorRotation: Quaternion): Quaternion = getYawQuaternion(sensorRotation).inv()

	private fun fixAttachment(sensorRotation: Quaternion): Quaternion = (gyroFix * sensorRotation).inv()

	private fun fixYaw(sensorRotation: Quaternion, reference: Quaternion): Quaternion {
		var rot = gyroFix * sensorRotation
		rot *= attachmentFix
		rot = mountRotFix.inv() * (rot * mountRotFix)
		rot = getYawQuaternion(rot)
		return rot.inv() * reference.project(Vector3.POS_Y).unit()
	}

	private fun getYawQuaternion(rot: Quaternion): Quaternion {
		val yaw = rot.toEulerAngles(EulerOrder.YZX).y
		return EulerAngles(EulerOrder.YZX, 0f, yaw, 0f).toQuaternion()
	}

	private fun makeIdentityAdjustmentQuatsFull() {
		val sensorRotation = tracker.getRawRotation()
		gyroFixNoMounting = fixGyroscope(sensorRotation)
		attachmentFixNoMounting = (gyroFixNoMounting * sensorRotation).inv()
		yawFixZeroReference = Quaternion.IDENTITY
	}

	private fun makeIdentityAdjustmentQuatsYaw() {
		var sensorRotation = tracker.getRawRotation()
		sensorRotation = gyroFixNoMounting * sensorRotation
		sensorRotation *= attachmentFixNoMounting
		yawFixZeroReference = fixGyroscope(sensorRotation)
	}

	/**
	 * Calculates drift since last reset and store the data related to it in
	 * driftQuat and timeAtLastReset
	 */
	private fun calculateDrift(beforeQuat: Quaternion) {
		if (driftCompensationEnabled) {
			val rotQuat = adjustToReference(tracker.getRawRotation())

			if (driftSince > 0 && System.currentTimeMillis() - timeAtLastReset > DRIFT_COOLDOWN_MS) {
				// Check and remove from lists to keep them under the reset limit
				if (driftQuats.size == driftQuats.capacity()) {
					driftQuats.removeLast()
					driftTimes.removeLast()
				}

				// Add new drift quaternion
				driftQuats.add(getYawQuaternion(rotQuat) / getYawQuaternion(beforeQuat))

				// Add drift time to total
				driftTimes.add(System.currentTimeMillis() - driftSince)
				totalDriftTime = 0
				for (time in driftTimes) {
					totalDriftTime += time
				}

				// Calculate drift Quaternions' weights
				val driftWeights = ArrayList<Float>(driftTimes.size)
				for (time in driftTimes) {
					driftWeights.add(time.toFloat() / totalDriftTime.toFloat())
				}

				// Make it so recent Quaternions weigh more
				for (i in driftWeights.size - 1 downTo 1) {
					// Add some of i-1's value to i
					driftWeights[i] = driftWeights[i] + driftWeights[i - 1] / driftWeights.size
					// Remove the value that was added to i from i-1
					driftWeights[i - 1] = driftWeights[i - 1] - driftWeights[i - 1] / driftWeights.size
				}

				// Set final averaged drift Quaternion
				averagedDriftQuat = fromAveragedQuaternions(driftQuats, driftWeights)

				// Save tracker rotation and current time
				rotationSinceReset = driftQuats.latest
				timeAtLastReset = System.currentTimeMillis()
			} else if (System.currentTimeMillis() - timeAtLastReset < DRIFT_COOLDOWN_MS && driftQuats.size > 0) {
				// Replace latest drift quaternion
				rotationSinceReset *= (getYawQuaternion(rotQuat) / getYawQuaternion(beforeQuat))
				driftQuats[driftQuats.size - 1] = rotationSinceReset

				// Add drift time to total
				driftTimes[driftTimes.size - 1] = driftTimes.latest + System.currentTimeMillis() - driftSince
				totalDriftTime = 0
				for (time in driftTimes) {
					totalDriftTime += time
				}

				// Calculate drift Quaternions' weights
				val driftWeights = ArrayList<Float>(driftTimes.size)
				for (time in driftTimes) {
					driftWeights.add(time.toFloat() / totalDriftTime.toFloat())
				}

				// Make it so recent Quaternions weigh more
				for (i in driftWeights.size - 1 downTo 1) {
					// Add some of i-1's value to i
					driftWeights[i] = driftWeights[i] + driftWeights[i - 1] / driftWeights.size
					// Remove the value that was added to i from i-1
					driftWeights[i - 1] = driftWeights[i - 1] - driftWeights[i - 1] / driftWeights.size
				}

				// Set final averaged drift Quaternion
				averagedDriftQuat = fromAveragedQuaternions(driftQuats, driftWeights)
			} else {
				timeAtLastReset = System.currentTimeMillis()
			}

			driftSince = System.currentTimeMillis()
		}
	}

	/**
	 * Estimates how much yaw drift has accumulated since the last reset, using the
	 * measured drift rate. Used to hand a badly drifting tracker off to a fallback
	 * estimate. Returns 0 until a rate has been measured.
	 */
	fun estimatedDriftSinceResetDeg(): Float {
		if (measuredDriftRateDegPerMin == 0f || driftMeasureSince == 0L) return 0f
		val minutesSinceReset = (System.currentTimeMillis() - driftMeasureSince) / 60000f
		return measuredDriftRateDegPerMin * minutesSinceReset
	}

	/**
	 * Measures the yaw drift rate at each reset, independent of drift
	 * compensation, so logging, the GUI, and Stay Aligned can use it
	 */
	private fun measureDrift(beforeQuat: Quaternion) {
		val now = System.currentTimeMillis()
		if (driftMeasureSince > 0) {
			val elapsed = now - driftMeasureSince
			if (elapsed > DRIFT_MEASURE_MAX_MS) {
				LogManager.info(
					"[TrackerResetsHandler] ${tracker.name} skipping drift measurement, interval " +
						"%.1f min too long to trust (yaw may have wrapped)".format(elapsed / 60000.0),
				)
			} else if (elapsed >= DRIFT_MEASURE_MIN_MS) {
				val rotQuat = adjustToReference(tracker.getRawRotation())
				val driftQuat = getYawQuaternion(rotQuat) / getYawQuaternion(beforeQuat)
				val driftDeg = Math.toDegrees(driftQuat.angleR().toDouble())
				val sampleRate = (driftDeg / (elapsed / 60000.0)).toFloat()

				val established = measuredDriftRateDegPerMin > 0f
				// A sudden jump far above an established estimate looks like a physical slip or
				// reposition rather than drift. But a genuinely fast tracker (a hot one) drifts
				// like that for real, so only a ONE OFF jump is dropped: a relative and an
				// absolute gate flag the jump, and we reject it just a couple of times in a row.
				val looksLikeSlip = established &&
					sampleRate - measuredDriftRateDegPerMin > DRIFT_RATE_OUTLIER_MIN_ABS_DEG_PER_MIN &&
					sampleRate > measuredDriftRateDegPerMin * DRIFT_RATE_OUTLIER_FACTOR

				if (looksLikeSlip && consecutiveSlipSamples < DRIFT_RATE_MAX_CONSECUTIVE_SLIPS) {
					consecutiveSlipSamples++
					LogManager.info(
						"[TrackerResetsHandler] ${tracker.name} ignoring drift sample " +
							"%.2f deg/min as a possible slip, keeping %.2f deg/min".format(
								sampleRate,
								measuredDriftRateDegPerMin,
							),
					)
				} else {
					// A normal sample blends into the running estimate so it reflects several
					// resets. A sustained big jump (slip looking but it keeps happening) is real
					// fast drift, so take it directly instead of leaving a fast tracker stuck low.
					measuredDriftRateDegPerMin = if (established && !looksLikeSlip) {
						measuredDriftRateDegPerMin +
							(sampleRate - measuredDriftRateDegPerMin) * DRIFT_RATE_EMA_ALPHA
					} else {
						sampleRate
					}
					consecutiveSlipSamples = 0
					// Attribute this sample to the interval's average temperature so the model
					// learns how this tracker drifts as it warms.
					averageTemp(driftMeasureStartTemp, tracker.temperature)?.let {
						tempDriftModel.record(it, sampleRate)
					}
					LogManager.info(
						"[TrackerResetsHandler] ${tracker.name} measured yaw drift: " +
							"%.2f deg over %.1f min (%.2f deg/min sample, %.2f deg/min smoothed)".format(
								driftDeg,
								elapsed / 60000.0,
								sampleRate,
								measuredDriftRateDegPerMin,
							),
					)
				}
			}
		}
		driftMeasureSince = now
		driftMeasureStartTemp = tracker.temperature
	}

	/**
	 * Calculates and returns the averaged Quaternion
	 * from the given Quaternions and weights.
	 */
	private fun fromAveragedQuaternions(
		qn: CircularArrayList<Quaternion>,
		tn: ArrayList<Float>,
	): Quaternion {
		var totalMatrix = qn[0].toMatrix() * tn[0]
		for (i in 1 until qn.size) {
			totalMatrix += (qn[i].toMatrix() * tn[i])
		}
		return totalMatrix.toQuaternion()
	}
}
