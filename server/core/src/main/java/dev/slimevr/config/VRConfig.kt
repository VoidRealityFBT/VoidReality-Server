package dev.slimevr.config

import com.fasterxml.jackson.databind.annotation.JsonDeserialize
import com.fasterxml.jackson.databind.annotation.JsonSerialize
import com.fasterxml.jackson.databind.ser.std.StdKeySerializers
import com.github.jonpeterson.jackson.module.versioning.JsonVersionedModel
import dev.slimevr.config.serializers.BridgeConfigMapDeserializer
import dev.slimevr.config.serializers.TrackerConfigMapDeserializer
import dev.slimevr.tracking.trackers.Tracker
import dev.slimevr.tracking.trackers.TrackerRole

@JsonVersionedModel(
	currentVersion = "15",
	defaultDeserializeToVersion = "15",
	toCurrentConverterClass = CurrentVRConfigConverter::class,
)
class VRConfig {
	val server: ServerConfig = ServerConfig()

	val filters: FiltersConfig = FiltersConfig()

	val driftCompensation: DriftCompensationConfig = DriftCompensationConfig()

	val oscRouter: OSCConfig = OSCConfig()

	val vrcOSC: VRCOSCConfig = VRCOSCConfig()

	@get:JvmName("getVMC")
	val vmc: VMCConfig = VMCConfig()

	val autoBone: AutoBoneConfig = AutoBoneConfig()

	val keybindings: KeybindingsConfig = KeybindingsConfig()

	val skeleton: SkeletonConfig = SkeletonConfig()

	val legTweaks: LegTweaksConfig = LegTweaksConfig()

	val tapDetection: TapDetectionConfig = TapDetectionConfig()

	val resetsConfig: ResetsConfig = ResetsConfig()

	val stayAlignedConfig = StayAlignedConfig()

	val hidConfig = HIDConfig()

	@JsonDeserialize(using = TrackerConfigMapDeserializer::class)
	@JsonSerialize(keyUsing = StdKeySerializers.StringKeySerializer::class)
	private val trackers: MutableMap<String, TrackerConfig> = HashMap()

	@JsonDeserialize(using = BridgeConfigMapDeserializer::class)
	@JsonSerialize(keyUsing = StdKeySerializers.StringKeySerializer::class)
	private val bridges: MutableMap<String, BridgeConfig> = HashMap()

	val knownDevices: MutableSet<String> = mutableSetOf()

	// Last board type (by id) each device reported, keyed by MAC. Lets us keep matching the
	// right firmware to a tracker even if it later boots firmware that does not report a board.
	val deviceBoardTypes: MutableMap<String, Int> = mutableMapOf()

	// Learned drift-rate-versus-temperature curve per tracker, keyed by MAC, as a map of bin
	// center temperature (C) to drift rate (deg/min). Persisting it lets a known tracker start
	// a session already knowing its warm-up drift so it needs fewer early resets.
	val deviceDriftModels: MutableMap<String, MutableMap<String, Float>> = mutableMapOf()

	val overlay: OverlayConfig = OverlayConfig()

	val trackingChecklist: TrackingChecklistConfig = TrackingChecklistConfig()

	val velocityConfig: VelocityConfig = VelocityConfig()

	val vrcConfig: VRCConfig = VRCConfig()

	init {
		// Initialize default settings for OSC Router
		oscRouter.portIn = 9002
		oscRouter.portOut = 9000

		// Initialize default settings for VRC OSC
		vrcOSC.portIn = 9001
		vrcOSC.portOut = 9000
		vrcOSC
			.setOSCTrackerRole(
				TrackerRole.WAIST,
				vrcOSC.getOSCTrackerRole(TrackerRole.WAIST, true),
			)
		vrcOSC
			.setOSCTrackerRole(
				TrackerRole.LEFT_FOOT,
				vrcOSC.getOSCTrackerRole(TrackerRole.WAIST, true),
			)
		vrcOSC
			.setOSCTrackerRole(
				TrackerRole.RIGHT_FOOT,
				vrcOSC.getOSCTrackerRole(TrackerRole.WAIST, true),
			)

		// Initialize default settings for VMC
		vmc.portIn = 39540
		vmc.portOut = 39539
	}

	fun getTrackers(): Map<String, TrackerConfig> = trackers

	fun getBridges(): Map<String, BridgeConfig> = bridges

	fun hasTrackerByName(name: String): Boolean = trackers.containsKey(name)

	fun getTracker(tracker: Tracker): TrackerConfig {
		var config = trackers[tracker.name]
		if (config == null) {
			config = TrackerConfig(tracker)
			trackers[tracker.name] = config
		}
		return config
	}

	fun readTrackerConfig(tracker: Tracker) {
		if (tracker.userEditable) {
			val config = getTracker(tracker)
			tracker.readConfig(config)
			if (tracker.isImu()) tracker.resetsHandler.readDriftCompensationConfig(driftCompensation)
			tracker.resetsHandler.readResetConfig(resetsConfig)
			if (tracker.allowReset) {
				tracker.saveMountingResetOrientation(config)
			}
			if (tracker.allowFiltering) {
				tracker
					.filteringHandler
					.readFilteringConfig(filters, tracker.getRotation())
			}
		}
		tracker.allowVelocity = velocityConfig.sendDerivedVelocity
	}

	fun writeTrackerConfig(tracker: Tracker?) {
		if (tracker?.userEditable == true) {
			val tc = getTracker(tracker)
			tracker.writeConfig(tc)
		}
	}

	fun getBridge(bridgeKey: String): BridgeConfig {
		var config = bridges[bridgeKey]
		if (config == null) {
			config = BridgeConfig()
			bridges[bridgeKey] = config
		}
		return config
	}

	fun isKnownDevice(mac: String?): Boolean = knownDevices.contains(mac)

	fun addKnownDevice(mac: String): Boolean = knownDevices.add(mac)

	fun forgetKnownDevice(mac: String): Boolean = knownDevices.remove(mac)

	fun getRememberedBoardType(mac: String?): Int? = if (mac == null) null else deviceBoardTypes[mac]

	// Returns true when the stored value actually changed, so the caller only saves when needed
	fun rememberBoardType(mac: String, boardId: Int): Boolean {
		if (deviceBoardTypes[mac] == boardId) return false
		deviceBoardTypes[mac] = boardId
		return true
	}

	fun getDriftModel(mac: String?): Map<String, Float>? =
		if (mac == null) null else deviceDriftModels[mac]

	// Returns true when the stored model actually changed, so the caller only saves when needed
	fun rememberDriftModel(mac: String, bins: Map<String, Float>): Boolean {
		if (bins.isEmpty() || deviceDriftModels[mac] == bins) return false
		deviceDriftModels[mac] = bins.toMutableMap()
		return true
	}
}
