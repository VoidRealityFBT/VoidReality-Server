package dev.slimevr

import com.jme3.system.NanoTimer
import dev.slimevr.autobone.AutoBoneHandler
import dev.slimevr.bridge.Bridge
import dev.slimevr.bridge.ISteamVRBridge
import dev.slimevr.config.ConfigManager
import dev.slimevr.firmware.FirmwareUpdateHandler
import dev.slimevr.firmware.SerialFlashingHandler
import dev.slimevr.games.vrchat.VRCConfigHandler
import dev.slimevr.games.vrchat.VRCConfigHandlerStub
import dev.slimevr.games.vrchat.VRChatConfigManager
import dev.slimevr.guards.ServerGuards
import dev.slimevr.osc.OSCHandler
import dev.slimevr.osc.OSCRouter
import dev.slimevr.osc.VMCHandler
import dev.slimevr.osc.VRCOSCHandler
import dev.slimevr.posestreamer.BVHRecorder
import dev.slimevr.protocol.ProtocolAPI
import dev.slimevr.protocol.rpc.TransactionInfo
import dev.slimevr.protocol.rpc.settings.RPCSettingsHandler
import dev.slimevr.reset.ResetHandler
import dev.slimevr.reset.ResetTimerManager
import dev.slimevr.reset.resetTimer
import dev.slimevr.serial.ProvisioningHandler
import dev.slimevr.serial.SerialHandler
import dev.slimevr.serial.SerialHandlerStub
import dev.slimevr.setup.HandshakeHandler
import dev.slimevr.setup.TapSetupHandler
import dev.slimevr.status.StatusSystem
import dev.slimevr.tracking.processor.HumanPoseManager
import dev.slimevr.tracking.processor.skeleton.HumanSkeleton
import dev.slimevr.tracking.trackers.*
import dev.slimevr.tracking.trackers.udp.TrackersUDPServer
import dev.slimevr.trackingchecklist.TrackingChecklistManager
import dev.slimevr.util.ann.VRServerThread
import dev.slimevr.websocketapi.WebSocketVRBridge
import io.eiren.util.ann.ThreadSafe
import io.eiren.util.ann.ThreadSecure
import io.eiren.util.collections.FastList
import io.eiren.util.logging.LogManager
import solarxr_protocol.datatypes.TrackerIdT
import solarxr_protocol.rpc.ResetType
import java.util.*
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicInteger
import java.util.function.Consumer
import kotlin.collections.ArrayList
import kotlin.concurrent.schedule

typealias BridgeProvider = (
	server: VRServer,
	computedTrackers: List<Tracker>,
) -> Sequence<Bridge>

const val SLIMEVR_IDENTIFIER = "dev.slimevr.SlimeVR"

// Delay before auto yaw resetting a reconnected tracker, lets its data stabilize first
// Give a reconnecting IMU time to let its fusion settle before realigning. A hot tracker
// converges slower, so a short delay would reset on a still moving estimate and misalign.
private const val RECONNECT_YAW_RESET_DELAY_MS = 5000L

// Only auto realign a tracker that was actually offline for at least this long. A brief wifi
// blip barely drifts, and realigning on every reconnect spams the user with constant resets
private const val MIN_OFFLINE_FOR_REALIGN_MS = 30000L

class VRServer @JvmOverloads constructor(
	bridgeProvider: BridgeProvider = { _, _ -> sequence {} },
	featureFlagsProvider: (VRServer) -> FeatureFlags = { _ -> FeatureFlags() },
	serialHandlerProvider: (VRServer) -> SerialHandler = { _ -> SerialHandlerStub() },
	flashingHandlerProvider: (VRServer) -> SerialFlashingHandler? = { _ -> null },
	vrcConfigHandlerProvider: (VRServer) -> VRCConfigHandler = { _ -> VRCConfigHandlerStub() },
	networkProfileProvider: (VRServer) -> NetworkProfileChecker = { _ -> StubNetworkProfileChecker() },
	acquireMulticastLock: () -> Any? = { null },
	@JvmField val configManager: ConfigManager,
) : Thread("VRServer") {

	@JvmField
	val humanPoseManager: HumanPoseManager
	private val trackers: MutableList<Tracker> = FastList()
	val trackersServer: TrackersUDPServer
	private val bridges: MutableList<Bridge> = FastList()
	private val tasks: Queue<Runnable> = LinkedBlockingQueue()

	// timestamp of the last periodic tracking summary log
	private var lastTrackingSummaryMs = System.currentTimeMillis()
	private val newTrackersConsumers: MutableList<Consumer<Tracker>> = FastList()
	private val trackerStatusListeners: MutableList<TrackerStatusListener> = FastList()
	private val onTick: MutableList<Runnable> = FastList()
	private val lock = acquireMulticastLock()
	val oSCRouter: OSCRouter

	@JvmField
	val vrcOSCHandler: VRCOSCHandler
	val vMCHandler: VMCHandler

	@JvmField
	val deviceManager: DeviceManager

	// UwU <- WHO TF ADDED THIS?!?!?!?!?!?!?!??!?!? (meow :3)
	val featureFlags: FeatureFlags = featureFlagsProvider(this)

	@JvmField
	val bvhRecorder: BVHRecorder

	@JvmField
	val serialHandler: SerialHandler

	var serialFlashingHandler: SerialFlashingHandler?

	val firmwareUpdateHandler: FirmwareUpdateHandler

	val vrcConfigManager: VRChatConfigManager

	@JvmField
	val autoBoneHandler: AutoBoneHandler

	@JvmField
	val tapSetupHandler: TapSetupHandler

	@JvmField
	val protocolAPI: ProtocolAPI
	private val timer = Timer()
	private val resetTimerManager = ResetTimerManager()

	// Body parts of trackers that reconnected and are waiting for one debounced realign.
	private val reconnectYawResetBodyParts = Collections.synchronizedSet(HashSet<Int>())
	val fpsTimer = NanoTimer()

	@JvmField
	val provisioningHandler: ProvisioningHandler

	@JvmField
	val resetHandler: ResetHandler

	@JvmField
	val statusSystem = StatusSystem()

	@JvmField
	val handshakeHandler = HandshakeHandler()

	val trackingChecklistManager: TrackingChecklistManager

	val networkProfileChecker: NetworkProfileChecker

	val serverGuards = ServerGuards()

	init {
		deviceManager = DeviceManager(this)
		serialHandler = serialHandlerProvider(this)
		serialFlashingHandler = flashingHandlerProvider(this)
		provisioningHandler = ProvisioningHandler(this)
		resetHandler = ResetHandler()
		tapSetupHandler = TapSetupHandler()
		humanPoseManager = HumanPoseManager(this)
		// AutoBone requires HumanPoseManager first
		autoBoneHandler = AutoBoneHandler(this)
		firmwareUpdateHandler = FirmwareUpdateHandler(this)
		vrcConfigManager = VRChatConfigManager(this, vrcConfigHandlerProvider(this))
		networkProfileChecker = networkProfileProvider(this)
		trackingChecklistManager = TrackingChecklistManager(this)
		protocolAPI = ProtocolAPI(this)
		val computedTrackers = humanPoseManager.computedTrackers

		// Start server for SlimeVR trackers
		val trackerPort = configManager.vrConfig.server.trackerPort
		LogManager.info("Starting the tracker server on port $trackerPort...")
		trackersServer = TrackersUDPServer(
			trackerPort,
			"Sensors UDP server",
		) { tracker: Tracker -> registerTracker(tracker) }

		// Start bridges and WebSocket server
		for (bridge in bridgeProvider(this, computedTrackers) + sequenceOf(WebSocketVRBridge(computedTrackers, this))) {
			tasks.add(Runnable { bridge.startBridge() })
			bridges.add(bridge)
		}

		// Initialize OSC handlers
		vrcOSCHandler = VRCOSCHandler(
			this,
			configManager.vrConfig.vrcOSC,
			computedTrackers,
		)
		vMCHandler = VMCHandler(
			this,
			humanPoseManager,
			configManager.vrConfig.vmc,
		)

		// Initialize OSC router
		val oscHandlers = FastList<OSCHandler>()
		oscHandlers.add(vrcOSCHandler)
		oscHandlers.add(vMCHandler)
		oSCRouter = OSCRouter(configManager.vrConfig.oscRouter, oscHandlers)
		bvhRecorder = BVHRecorder(this)
		for (tracker in computedTrackers) {
			registerTracker(tracker)
		}

		instance = this
	}

	fun hasBridge(bridgeClass: Class<out Bridge?>): Boolean {
		for (bridge in bridges) {
			if (bridgeClass.isAssignableFrom(bridge.javaClass)) {
				return true
			}
		}
		return false
	}

	@ThreadSafe
	fun getVRBridge(pred: (Bridge) -> Boolean): Bridge? {
		for (bridge in bridges) {
			if (pred(bridge)) return bridge
		}
		return null
	}

	@ThreadSafe
	fun removeVRBridge(bridge: Bridge) {
		bridge.stopBridge()
		bridges.remove(bridge)
	}

	fun addOnTick(runnable: Runnable) {
		onTick.add(runnable)
	}

	@ThreadSafe
	fun addNewTrackerConsumer(consumer: Consumer<Tracker>) {
		queueTask {
			newTrackersConsumers.add(consumer)
			for (tracker in trackers) {
				consumer.accept(tracker)
			}
		}
	}

	@ThreadSafe
	fun trackerUpdated(tracker: Tracker?) {
		queueTask {
			humanPoseManager.trackerUpdated(tracker)
			updateSkeletonModel()
			refreshTrackersDriftCompensationEnabled()
			configManager.vrConfig.writeTrackerConfig(tracker)
			configManager.saveConfig()
		}
	}

	@ThreadSafe
	fun addSkeletonUpdatedCallback(consumer: Consumer<HumanSkeleton>) {
		queueTask { humanPoseManager.addSkeletonUpdatedCallback(consumer) }
	}

	@VRServerThread
	override fun run() {
		trackersServer.start()
		while (true) {
			// final long start = System.currentTimeMillis();
			fpsTimer.update()
			do {
				val task = tasks.poll() ?: break
				task.run()
			} while (true)
			for (task in onTick) {
				task.run()
			}
			for (bridge in bridges) {
				bridge.dataRead()
			}
			for (tracker in trackers) {
				tracker.tick(fpsTimer.timePerFrame)
			}
			humanPoseManager.update()
			for (bridge in bridges) {
				bridge.dataWrite()
			}
			vrcOSCHandler.update()
			vMCHandler.update()
			logTrackingSummaryIfDue()
			// final long time = System.currentTimeMillis() - start;
			try {
				sleep(1) // 1000Hz
			} catch (error: InterruptedException) {
				LogManager.info("VRServer thread interrupted")
				break
			}
		}
	}

	/**
	 * Logs a per tracker quality summary every ten minutes so sessions can
	 * be compared from the log file alone
	 */
	@VRServerThread
	private fun logTrackingSummaryIfDue() {
		val now = System.currentTimeMillis()
		if (now - lastTrackingSummaryMs < 10 * 60 * 1000) return
		lastTrackingSummaryMs = now
		var driftModelsChanged = false
		for (tracker in trackers) {
			if (!tracker.isImu()) continue
			val drift = tracker.resetsHandler.measuredDriftRateDegPerMin
			val driftText = if (drift != 0f) "%.2f deg/min".format(drift) else "not measured"
			val tempText = tracker.temperature?.let { ", temp %.1f C".format(it) } ?: ""
			LogManager.info(
				"[TrackingSummary] ${tracker.name}: status ${tracker.status}, drift $driftText$tempText",
			)
			// Persist the learned drift versus temperature curve so it carries to next session.
			val mac = tracker.device?.hardwareIdentifier
			if (mac != null && mac != "Unknown" &&
				configManager.vrConfig.rememberDriftModel(mac, tracker.resetsHandler.exportDriftModel())
			) {
				driftModelsChanged = true
			}
		}
		if (driftModelsChanged) configManager.saveConfig()
	}

	@ThreadSafe
	fun queueTask(r: Runnable) {
		tasks.add(r)
	}

	@VRServerThread
	private fun trackerAdded(tracker: Tracker) {
		humanPoseManager.trackerAdded(tracker)
		updateSkeletonModel()
		if (tracker.isComputed) {
			vMCHandler.addComputedTracker(tracker)
		}
		refreshTrackersDriftCompensationEnabled()
	}

	@ThreadSecure
	fun registerTracker(tracker: Tracker) {
		configManager.vrConfig.readTrackerConfig(tracker)
		queueTask {
			trackers.add(tracker)
			trackerAdded(tracker)
			for (tc in newTrackersConsumers) {
				tc.accept(tracker)
			}
		}
	}

	@ThreadSafe
	fun updateSkeletonModel() {
		queueTask {
			humanPoseManager.updateSkeletonModelFromServer()
			vrcOSCHandler.setHeadTracker(TrackerUtils.getTrackerForSkeleton(trackers, TrackerPosition.HEAD))

			val bridge = this.getVRBridge {
				it is ISteamVRBridge
			} as? ISteamVRBridge
			bridge?.updateShareSettingsAutomatically()
			RPCSettingsHandler.sendSteamVRUpdatedSettings(protocolAPI, protocolAPI.rpcHandler)
		}
	}

	fun resetTrackersFull(resetSourceName: String?, bodyParts: List<Int> = ArrayList()) {
		queueTask { humanPoseManager.resetTrackersFull(resetSourceName, bodyParts) }
	}

	fun resetTrackersYaw(resetSourceName: String?, bodyParts: List<Int> = TrackerUtils.allBodyPartsButFingers) {
		queueTask { humanPoseManager.resetTrackersYaw(resetSourceName, bodyParts) }
	}

	fun resetTrackersMounting(resetSourceName: String?, bodyParts: List<Int>? = null) {
		queueTask { humanPoseManager.resetTrackersMounting(resetSourceName, bodyParts) }
	}

	fun clearTrackersMounting(resetSourceName: String?) {
		queueTask { humanPoseManager.clearTrackersMounting(resetSourceName) }
	}

	fun getPauseTracking(): Boolean = humanPoseManager.getPauseTracking()

	fun setPauseTracking(pauseTracking: Boolean, sourceName: String?) {
		queueTask {
			humanPoseManager.setPauseTracking(pauseTracking, sourceName)
			// Toggle trackers as they don't toggle when tracking is paused
			val bridge = this.getVRBridge {
				it is ISteamVRBridge
			} as? ISteamVRBridge
			bridge?.updateShareSettingsAutomatically()
			RPCSettingsHandler.sendSteamVRUpdatedSettings(protocolAPI, protocolAPI.rpcHandler)
		}
	}

	fun togglePauseTracking(sourceName: String?) {
		queueTask {
			humanPoseManager.togglePauseTracking(sourceName)
			// Toggle trackers as they don't toggle when tracking is paused
			val bridge = this.getVRBridge {
				it is ISteamVRBridge
			} as? ISteamVRBridge
			bridge?.updateShareSettingsAutomatically()
			RPCSettingsHandler.sendSteamVRUpdatedSettings(protocolAPI, protocolAPI.rpcHandler)
		}
	}

	fun scheduleResetTrackersFull(resetSourceName: String?, delay: Long, bodyParts: List<Int> = ArrayList(), tx: TransactionInfo? = null) {
		resetTimer(
			resetTimerManager,
			delay,
			onTick = { progress ->
				resetHandler.sendStarted(ResetType.Full, tx, bodyParts, progress, delay.toInt())
			},
			onComplete = {
				queueTask {
					humanPoseManager.resetTrackersFull(resetSourceName, bodyParts)
					resetHandler.sendFinished(ResetType.Full, tx, bodyParts, delay.toInt())
				}
			},
		)
	}

	fun scheduleResetTrackersYaw(resetSourceName: String?, delay: Long, bodyParts: List<Int> = TrackerUtils.allBodyPartsButFingers, tx: TransactionInfo? = null) {
		resetTimer(
			resetTimerManager,
			delay,
			onTick = { progress ->
				resetHandler.sendStarted(ResetType.Yaw, tx, bodyParts, progress, delay.toInt())
			},
			onComplete = {
				queueTask {
					humanPoseManager.resetTrackersYaw(resetSourceName, bodyParts)
					resetHandler.sendFinished(ResetType.Yaw, tx, bodyParts, delay.toInt())
				}
			},
		)
	}

	/**
	 * Realigns a reconnected tracker's yaw, the same correction used when a tracker is turned
	 * off and back on, but also covering a fast rehandshake that never times out. The tracker
	 * keeps its saved calibration; only the yaw that drifted while it was gone is realigned.
	 * Calls coalesce through the shared reset timer, so a reconnect storm produces a single
	 * yaw reset a few seconds after the last tracker returns, covering every tracker that came
	 * back.
	 */
	fun scheduleReconnectYawReset(tracker: Tracker) {
		val bodyPart = tracker.trackerPosition?.bodyPart ?: return
		if (!tracker.isImu() || !tracker.allowReset || tracker.resetsHandler.lastResetQuaternion == null) {
			return
		}
		// Only realign if the tracker was actually gone long enough to have drifted. This stops
		// a flaky link's constant brief reconnects from firing a realign every time.
		if (System.currentTimeMillis() - tracker.wentOfflineAtMs < MIN_OFFLINE_FOR_REALIGN_MS) {
			return
		}
		reconnectYawResetBodyParts.add(bodyPart)
		val bodyParts = synchronized(reconnectYawResetBodyParts) { reconnectYawResetBodyParts.toList() }
		resetTimer(
			resetTimerManager,
			RECONNECT_YAW_RESET_DELAY_MS,
			onTick = { progress ->
				resetHandler.sendStarted(ResetType.Yaw, null, bodyParts, progress, RECONNECT_YAW_RESET_DELAY_MS.toInt())
			},
			onComplete = {
				queueTask {
					humanPoseManager.resetTrackersYaw("Auto reconnect", bodyParts)
					resetHandler.sendFinished(ResetType.Yaw, null, bodyParts, RECONNECT_YAW_RESET_DELAY_MS.toInt())
					reconnectYawResetBodyParts.clear()
				}
			},
		)
	}

	fun scheduleResetTrackersMounting(resetSourceName: String?, delay: Long, bodyParts: List<Int>? = null, tx: TransactionInfo? = null) {
		resetTimer(
			resetTimerManager,
			delay,
			onTick = { progress ->
				resetHandler.sendStarted(ResetType.Mounting, tx, bodyParts, progress, delay.toInt())
			},
			onComplete = {
				queueTask {
					humanPoseManager.resetTrackersMounting(resetSourceName, bodyParts)
					resetHandler.sendFinished(ResetType.Mounting, tx, bodyParts, delay.toInt())
				}
			},
		)
	}

	fun scheduleSetPauseTracking(pauseTracking: Boolean, sourceName: String?, delay: Long) {
		timer.schedule(delay) {
			queueTask { humanPoseManager.setPauseTracking(pauseTracking, sourceName) }
		}
	}

	fun scheduleTogglePauseTracking(sourceName: String?, delay: Long) {
		timer.schedule(delay) {
			queueTask { humanPoseManager.togglePauseTracking(sourceName) }
		}
	}

	fun setLegTweaksEnabled(value: Boolean) {
		queueTask { humanPoseManager.setLegTweaksEnabled(value) }
	}

	fun setSkatingReductionEnabled(value: Boolean) {
		queueTask { humanPoseManager.setSkatingCorrectionEnabled(value) }
	}

	fun setFloorClipEnabled(value: Boolean) {
		queueTask { humanPoseManager.setFloorClipEnabled(value) }
	}

	val trackersCount: Int
		get() = trackers.size
	val allTrackers: List<Tracker>
		get() = FastList(trackers)

	fun getTrackerById(id: TrackerIdT): Tracker? {
		for (tracker in trackers) {
			if (tracker.trackerNum != id.trackerNum) {
				continue
			}

			// Handle synthetic devices
			if (id.deviceId == null && tracker.device == null) {
				return tracker
			}
			if (tracker.device != null && id.deviceId != null && id.deviceId.id == tracker.device.id) {
				// This is a physical tracker, and both device id and the
				// tracker num match
				return tracker
			}
		}
		return null
	}

	fun clearTrackersDriftCompensation() {
		for (t in allTrackers) {
			if (t.isImu()) {
				t.resetsHandler.clearDriftCompensation()
			}
		}
	}

	fun refreshTrackersDriftCompensationEnabled() {
		for (t in allTrackers) {
			if (t.isImu()) {
				t.resetsHandler.refreshDriftCompensationEnabled()
			}
		}
	}

	fun trackerStatusChanged(tracker: Tracker, oldStatus: TrackerStatus, newStatus: TrackerStatus) {
		trackerStatusListeners.forEach { it.onTrackerStatusChanged(tracker, oldStatus, newStatus) }

		// When a previously reset IMU tracker drops out and comes back, its calibration is
		// preserved but its yaw drifted while offline. Schedule a yaw reset to realign it
		// instead of needing a full recalibration. Only reconnects, not first connect.
		// A fast rehandshake that never times out is handled in TrackersUDPServer.
		if (!oldStatus.sendData && newStatus == TrackerStatus.OK) {
			scheduleReconnectYawReset(tracker)
		}
	}

	fun addTrackerStatusListener(listener: TrackerStatusListener) {
		trackerStatusListeners.add(listener)
	}

	fun removeTrackerStatusListener(listener: TrackerStatusListener) {
		trackerStatusListeners.removeIf { listener == it }
	}

	companion object {
		private val nextLocalTrackerId = AtomicInteger()
		lateinit var instance: VRServer
			private set

		val instanceInitialized: Boolean
			get() = ::instance.isInitialized

		@JvmStatic
		fun getNextLocalTrackerId(): Int = nextLocalTrackerId.incrementAndGet()

		@JvmStatic
		val currentLocalTrackerId: Int
			get() = nextLocalTrackerId.get()
	}
}
