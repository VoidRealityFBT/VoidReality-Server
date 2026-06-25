package dev.slimevr.filtering

import com.jme3.system.NanoTimer
import dev.slimevr.VRServer
import io.github.axisangles.ktmath.Quaternion
import io.github.axisangles.ktmath.Quaternion.Companion.IDENTITY
import io.github.axisangles.ktmath.Vector3

// influences the range of smoothFactor.
private const val SMOOTH_MULTIPLIER = 42f
private const val SMOOTH_MIN = 11f

// influences the range of the prediction blend rate
private const val PREDICT_MULTIPLIER = 15f
private const val PREDICT_MIN = 10f

// how far ahead prediction looks at slider 100%, in seconds
private const val PREDICT_AHEAD_MAX_S = 0.06f

// time constant of the angular velocity smoothing, in seconds
private const val VELOCITY_SMOOTHING_S = 0.05f

// how much measured angular speed eases the smoothing so fast motion stays responsive
private const val SMOOTH_SPEED_GAIN = 5.0f

// prediction never rotates further than this, in radians
private const val MAX_PREDICT_ANGLE = 0.5f

// packet gaps longer than this reset the velocity estimate, in seconds
private const val MAX_SAMPLE_GAP_S = 0.5f

// a measured angular velocity is trusted over the finite-difference estimate for this
// long after it arrives, in seconds, before falling back to deriving it from quaternions
private const val MEASURED_VELOCITY_MAX_AGE_S = 0.1f

// At or below this average packet interval (seconds, ~50 Hz) the link is healthy and the
// adaptive smoothing does nothing. As the interval grows past it (packet loss makes updates
// sparse) the smoothing is increased so the body stays smooth instead of stuttering.
private const val GOOD_SAMPLE_GAP_S = 0.02f

// The adaptive smoothing never cuts the "catch-up" factor below this fraction, so even on a
// terrible link the body keeps easing toward new data rather than freezing.
private const val MIN_LOSS_SMOOTH_SCALE = 0.3f

// EMA weight for the average packet-interval estimate that drives the adaptive smoothing
private const val GAP_EMA_ALPHA = 0.1f

class QuaternionMovingAverage(
	val type: TrackerFilters,
	var amount: Float = 0f,
	initialRotation: Quaternion = IDENTITY,
) {
	var filteredQuaternion = IDENTITY
	var filteringImpact = 0f
	private var smoothFactor = 0f
	private var predictFactor = 0f
	private var predictAheadS = 0f
	private var angularVelocity = Vector3.NULL
	private var lastSampleTimeNs = 0L
	private var measuredVelocityTimeNs = 0L
	private var latestQuaternion = IDENTITY
	private var smoothingQuaternion = IDENTITY
	private val fpsTimer = if (VRServer.instanceInitialized) VRServer.instance.fpsTimer else NanoTimer()
	private var timeSinceUpdate = 0f
	private var avgSampleGapS = 0f

	init {
		// amount should range from 0 to 1.
		// GUI should clamp it from 0.01 (1%) or 0.1 (10%)
		// to 1 (100%).
		amount = amount.coerceAtLeast(0f)
		if (type == TrackerFilters.SMOOTHING) {
			// lower smoothFactor = more smoothing
			smoothFactor = SMOOTH_MULTIPLIER * (1 - amount.coerceAtMost(1f)) + SMOOTH_MIN
			// Totally a hack
			if (amount > 1) {
				smoothFactor /= amount
			}
		}
		if (type == TrackerFilters.PREDICTION) {
			// higher predictFactor = faster blend towards the predicted rotation
			predictFactor = PREDICT_MULTIPLIER * amount.coerceAtMost(1f) + PREDICT_MIN
			// the slider scales how far ahead in time we extrapolate
			predictAheadS = PREDICT_AHEAD_MAX_S * amount.coerceAtMost(1f)
		}

		// We have no reference at the start, so just use the initial rotation
		resetQuats(initialRotation, initialRotation)
	}

	// Runs at up to 1000hz. We use a timer to make it framerate-independent
	// since it runs a bit below 1000hz in practice.
	@Synchronized
	fun update() {
		if (type == TrackerFilters.PREDICTION) {
			// extrapolate along the smoothed angular velocity instead of replaying old deltas
			var rotVec = angularVelocity * predictAheadS
			val angle = rotVec.len()
			if (angle > MAX_PREDICT_ANGLE) {
				rotVec = rotVec * (MAX_PREDICT_ANGLE / angle)
			}
			val predictRot = latestQuaternion * Quaternion.fromRotationVector(rotVec)

			// Calculate how much to slerp
			// Limit slerp by a reasonable amount so low TPS doesnt break tracking
			val amt = (predictFactor * fpsTimer.timePerFrame).coerceAtMost(1f)

			// Slerps the target rotation to that predicted rotation by amt
			filteredQuaternion = filteredQuaternion.interpQ(predictRot, amt)
		} else if (type == TrackerFilters.SMOOTHING) {
			// Make it framerate-independent
			timeSinceUpdate += fpsTimer.timePerFrame

			// Ease the smoothing as the tracker moves faster so fast motion has less lag
			// while slow and resting motion keeps the heavy smoothing that hides jitter
			var effectiveFactor = smoothFactor + SMOOTH_SPEED_GAIN * angularVelocity.len()

			// Smooth more when packets get sparse (loss), so a flaky link looks less choppy.
			// At a healthy rate this scale is 1 and nothing changes; it only ever adds smoothing.
			if (avgSampleGapS > GOOD_SAMPLE_GAP_S) {
				effectiveFactor *= (GOOD_SAMPLE_GAP_S / avgSampleGapS).coerceAtLeast(MIN_LOSS_SMOOTH_SCALE)
			}

			// Calculate the slerp factor based off the smoothFactor and smoothingCounter
			// limit to 1 to not overshoot
			val amt = (effectiveFactor * timeSinceUpdate).coerceAtMost(1f)

			// Smooth towards the target rotation by the slerp factor
			filteredQuaternion = smoothingQuaternion.interpQ(latestQuaternion, amt)
		}

		filteringImpact = latestQuaternion.angleToR(filteredQuaternion)
	}

	@Synchronized
	fun addQuaternion(q: Quaternion) {
		val oldQ = latestQuaternion
		val newQ = q.twinNearest(oldQ)
		latestQuaternion = newQ

		// both prediction and adaptive smoothing need a stable angular velocity estimate
		if (type == TrackerFilters.PREDICTION || type == TrackerFilters.SMOOTHING) {
			val now = System.nanoTime()
			// If the firmware sent a measured angular velocity recently, trust it instead of
			// deriving one from quaternion deltas, which lags and is noisier at speed.
			val measuredFresh = measuredVelocityTimeNs != 0L &&
				(now - measuredVelocityTimeNs) * 1e-9f < MEASURED_VELOCITY_MAX_AGE_S
			if (lastSampleTimeNs != 0L) {
				val dt = (now - lastSampleTimeNs) * 1e-9f
				if (dt > 0f && dt < MAX_SAMPLE_GAP_S) {
					// Track the typical packet interval so the smoothing can react to loss
					avgSampleGapS = if (avgSampleGapS == 0f) {
						dt
					} else {
						avgSampleGapS + (dt - avgSampleGapS) * GAP_EMA_ALPHA
					}
					if (!measuredFresh) {
						// instantaneous angular velocity from the last two samples
						val instVel = (oldQ.inv() * newQ).toRotationVector() / dt
						// exponential moving average keeps it stable against packet jitter
						val alpha = (dt / VELOCITY_SMOOTHING_S).coerceAtMost(1f)
						angularVelocity += (instVel - angularVelocity) * alpha
					}
				} else if (!measuredFresh) {
					// gap too long, the old velocity is stale
					angularVelocity = Vector3.NULL
				}
			}
			lastSampleTimeNs = now
		}

		if (type == TrackerFilters.SMOOTHING) {
			timeSinceUpdate = 0f
			smoothingQuaternion = filteredQuaternion
		} else if (type == TrackerFilters.NONE) {
			// No filtering; just keep track of rotations (for going over 180 degrees)
			filteredQuaternion = newQ
		}
	}

	/**
	 * Feeds a measured angular velocity (radians per second, in the same frame as the
	 * filtered rotation) from the firmware gyro, used in place of the finite difference
	 * estimate while it stays fresh.
	 */
	@Synchronized
	fun setMeasuredAngularVelocity(velocity: Vector3) {
		if (type != TrackerFilters.PREDICTION && type != TrackerFilters.SMOOTHING) return
		angularVelocity = velocity
		measuredVelocityTimeNs = System.nanoTime()
	}

	/**
	 * Aligns the quaternion space of [q] to the [reference] and sets the latest
	 * [filteredQuaternion] immediately
	 */
	@Synchronized
	fun resetQuats(q: Quaternion, reference: Quaternion) {
		// Assume a rotation within 180 degrees of the reference
		// TODO: Currently the reference is the headset, this restricts all trackers to
		//  have at most a 180 degree rotation from the HMD during a reset, we can
		//  probably do better using a hierarchy
		val rot = q.twinNearest(reference)
		angularVelocity = Vector3.NULL
		lastSampleTimeNs = 0L
		measuredVelocityTimeNs = 0L
		latestQuaternion = rot
		filteredQuaternion = rot
		addQuaternion(rot)
	}
}
