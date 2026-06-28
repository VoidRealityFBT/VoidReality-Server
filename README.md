# VoidReality Server

This is the server and desktop interface half of VoidReality. It is an edited and rebranded build of the SlimeVR server. It takes the orientation packets coming from body worn IMU trackers over WiFi, builds a skeleton from them, and feeds that pose into SteamVR, into VRChat over OSC, and over VMC. 

This is not the SlimeVR project. It is an branch/edit of it. The original server is the work of Eiren Rain and the SlimeVR contributors, under the MIT and Apache 2.0 licenses kept in this directory. It is subject to change. See the disclaimer at the bottom.

## Why VoidReality differs from the base server

The base SlimeVR server is built to work acceptably for everyone, across every board, room, and body, with safe general defaults. VoidReality is built for one goal: less yaw drift, fewer recalibrations, and a body that stays where it should. That difference in aim is the reason for most of the changes below.

Where the base server picks a default that is safe on average, VoidReality measures the specific trackers in front of it and adapts to them: correction strength follows each tracker's own measured drift instead of a fixed gain, smoothing follows the live packet rate and motion speed instead of a fixed amount, and the network page shows the real numbers for this link instead of assuming the link is fine. Where the base server has one behavior that is correct while upright but wrong while lying down, VoidReality detects the pose and changes behavior rather than applying the upright rule everywhere. And where the base server drops or hands off a tracker on a heuristic, VoidReality keeps a live tracker tracking and only falls back on genuine loss of data. None of this turns an IMU into a lighthouse, but it removes the cases where the base server made a fine tracker behave worse than it had to. The how and the why of each are below; the feature list and the specific defects fixed follow in the next two sections.

## Installing VoidReality

It is recommended that you use the custom VoidReality Intallation software provided here:\
https://github.com/VoidRealityFBT/VoidReality-Installer

## Building and running yourself

```
`build.ps1 server` // builds the server jar
`build.ps1 gui`    // builds the graphical user interface
`build.ps1 app`    // builds both
`build.ps1 all`    // builds those plus the firmware.
```
The Kotlin server needs a JDK 17 or newer, since it cannot build on Java 8; the script finds one automatically.\
The interface needs Node with pnpm 10.33.

* `build.ps1 dist` builds the distributable executable for distribution.\
The jar, the native SteamVR bridge under `bindings-provider`, and the interface, packaged with electron-builder into a downloadable app and copied into `Release`. That needs CMake, the Visual Studio C++ build tools, and the OpenVR SDK populated at `bindings-provider\openvr` (an empty submodule in a fresh tree, so `git clone https://github.com/ValveSoftware/openvr bindings-provider\openvr` once first).

* `run.ps1` reinstalls dependencies if needed, recompiles and rebuilds the jar, restarts the server onto the fresh build, and opens the interface in development mode, so it always runs the latest code and works straight from a freshly cleaned tree.\
* `clean.ps1` does the deep clean (removes `node_modules`, the gradle cache, all build output, and the `Release` folders) to get the tree smaller.

## How the tracking works

A map of the parts that matter, so the behavior is not a black box. Each part notes what the base server does and, where VoidReality changes it, what it does instead and why.

**The skeleton**:\
Body pose is forward kinematics over a bone tree. Each tracker supplies the orientation of the bone it is strapped to, and the pose is built by walking the tree from a root and rotating each bone by its tracker's rotation. The tree is positionally anchored at the head, which is pinned to the headset, so the whole body hangs from the head and every other bone is placed relative to it. Bone lengths come from your proportions, set by hand or by AutoBone. This is why a missing tracker has to be estimated rather than left blank. It is also why head movement could move the body: in the base server the head and neck rotate by the headset's full rotation, so turning your head swept the body sideways. VoidReality takes the body's yaw from the spine when a spine tracker is present, while the head keeps its own pitch and roll, so looking around no longer drags the body, and the head pose sent to SteamVR is left unchanged.

**The yaw reset**:\
A reset takes a reference rotation, the headset's heading, and rotates each tracker's frame so its current heading registers as facing the same way. Internally a tracker holds a mounting rotation and a reset offset, and the reset solves for the offset that lines the tracker's measured heading up with the reference. Yaw, pitch, and roll are reset separately. The yaw component is pulled out of the tracker quaternion as the Y term of its YZX Euler decomposition; this is the stock extraction the build returned to after an experiment with a swing twist formulation oscillated and was reverted.

Yaw is degenerate when a limb is horizontal. Heading about the vertical axis is only well defined when the bone has a meaningful horizontal direction. A thigh or a spine held flat, as when you lie down, has almost no horizontal projection, so its computed yaw is numerically unstable and can flip. Several of the lying down behaviors here exist because of this single fact, not because of separate bugs.

**Stay Aligned**:\
This is the continuous yaw correction that runs between resets. It has two forces. A centering force gently pulls a tracker toward the heading it would have in a recognized relaxed pose: standing, sitting in a chair, or sitting on the ground. A locked force holds a tracker that has gone still at the last good heading it settled to, and that is what actually fights slow drift while you are not moving. The base server applies one fixed correction gain to every tracker and runs centering all the time. VoidReality changes this in three ways, each for the same reason: a fixed rule that is right on average is wrong for the tracker that is actually misbehaving. The correction authority is scaled by each tracker's measured drift, so a drifty tracker is pulled harder while a stable one is barely touched instead of both getting the same nudge. The ceiling on that authority was raised so a hot, fast drifting tracker can still be caught rather than being corrected too gently to keep up. And the centering force is paused whenever the detected pose is not upright, so it cannot drag horizontal legs into a crossed shape, while the locked force keeps running so a resting tracker is still pinned. Better, concretely: drifty trackers hold alignment longer and good ones are left alone, and lying down no longer scrambles the legs.

**The rotation filter**:\
Between the raw tracker stream, which arrives at up to a few hundred packets a second, and the pose sits a per tracker filter that runs framerate independent off a timer. It has three modes. None passes rotations straight through, only tracking the long way around past 180 degrees. The base server's smoothing eases toward the latest rotation by a fixed amount, which forces a single tradeoff between lag on fast motion and jitter at rest. VoidReality makes the smoothing adaptive on two axes. It eases as the tracker turns faster, by adding a term proportional to angular speed, so quick motion stays sharp while slow and resting motion is smoothed hard to hide jitter, instead of one compromise setting for both. And it tracks the live gap between packets and, when that gap grows because of packet loss, smooths more so a flaky link reads as calm motion rather than stutter, with a floor so the body never freezes; at a healthy packet rate this term does nothing, so it only ever helps on a bad link. Prediction extrapolates forward along a smoothed angular velocity by a small lookahead, clamped so a low packet rate cannot fling a limb, and it uses the firmware's own measured gyro velocity when that optional packet is present and recent rather than the noisier estimate derived from quaternion differences. Better, concretely: fast motion lags less, a lossy link looks smooth instead of choppy, and none of it costs anything when the link is healthy.

**Fallback and handoff**:\
A body part is driven by its tracker whenever that tracker is connected and sending data. If the tracker stops sending, the part is kept alive and driven by an estimate built from neighboring trackers, and the interface marks it as in fallback, so a tracker that dies mid session is replaced rather than the limb vanishing. The difference from the base server is the trigger. The base also handed a part off to the estimate once its tracker had drifted past an angle threshold, on the theory that a far drifted tracker is wrong; in practice that snapped a perfectly live limb into a default pose whenever a tracker ran hot or was held horizontal, which is the common case lying down. VoidReality keys handoff only on whether data is flowing, so a drifted but live tracker keeps tracking, drifted but real, and you fix it with a reset like normal. Better, concretely: limbs stop jumping into a standing pose while you are lying down or while a tracker is just warm.

**Drift measurement and learning**:\
At each reset the server records, per tracker, how far the heading had wandered since the previous reset and how long that took, and the ratio is a drift rate in degrees per minute. This is measured on the raw sensor heading before correction, so it describes the hardware, and the displayed number feeds the drift column, the chart, the session summary, and the reset reminder. Only an interval in a sensible window counts: too short and the measurement is mostly noise, too long and a fast tracker can drift more than 180 degrees of yaw, which wraps to the shortest angle and reads falsely low, so a very long gap between resets is skipped rather than learned from. The base server would simply overwrite this number each reset and forget it on restart. VoidReality treats it as something to learn from, in three steps that build on each other.

First, the rate is not overwritten but blended into a running estimate, so one noisy interval moves it only a little and Stay Aligned's correction strength stops lurching reset to reset. Second, a sample that jumps far above the established estimate is treated, the first time, as a physical slip, the tracker moving on the limb or being repositioned rather than drifting, and is dropped so a "one-off bump" does not poison the estimate. But a slip is a "one-off", while a tracker that genuinely drifts fast, such as one running hot, produces big samples again and again; so if the big samples keep coming, after a couple in a row the estimate is allowed to climb to the truth instead of every high sample being rejected forever. That is the difference between dropping a slip and letting a hot tracker report and be corrected for its real drift. Third, each kept sample is filed against the IMU temperature it was measured at, building a small per tracker map of drift rate versus temperature; Stay Aligned then asks that map what the drift rate is at the tracker's current temperature and scales its correction to match. Because gyro bias, the source of drift, shifts as the chip warms, this lets a warming tracker be corrected for its learned warm up drift continuously, instead of the correction only updating at the next reset. When the map has nothing learned for a temperature yet it falls back to the blended measured rate, so it is never worse than the measured value and at worst equal to it. The diagnostics page shows a stability readout, the spread of recent measurements, so you can see the estimate settle.

The temperature map is also remembered across sessions. It is saved per tracker, keyed by the tracker's MAC, into the server config the same way the remembered board type is, written out periodically and reloaded when the tracker connects. So a tracker the server has seen before starts a fresh session already knowing how it drifts as it warms, and its correction is scaled correctly from cold rather than only after the first couple of resets have remeasured it. You still do those first resets to set mounting, but over time, as the curve fills in across sessions, the early part of a session needs fewer of them. The map only holds drift rate against temperature, which is a property of the sensor, so it stays valid even though you mount the trackers a little differently each day; where a tracker sits is re-established by the reset, not by this.


## What is different from base SlimeVR

Everything here is new or meaningfully changed from the base server.

**Branding and theme**:\
The whole interface was restyled into a monochrome black and white look in the neutral `shadcn` style, set as the default. Name, icon, window title, and installer identity are VoidReality, and the SteamVR driver status icons were reskinned to match.

**Drift instrumentation**:\
Every tracker measures its own yaw drift rate in degrees per minute, taken at each reset. The interface shows a color coded drift column, a per tracker drift chart, a home screen session summary, and a diagnostics page with the full numbers, including a stability readout, the spread of recent measurements, that shows when the estimate has settled. This is raw sensor drift before correction, so it describes the hardware.

**Adaptive drift learning**:\
Rather than overwriting and forgetting the drift rate each reset, the server blends it into a running estimate, rejects samples that look like a physical slip or reposition instead of drift, and files each kept sample against the IMU temperature it was measured at. Stay Aligned then scales its correction to the drift predicted for the tracker's current temperature, so a warming tracker is corrected for its learned warm up drift continuously rather than only at the next reset. It is never worse than the plain measured rate, since it falls back to that when nothing is learned yet. This temperature curve persists across sessions, saved per tracker by MAC in the config, so a known tracker starts cold already knowing how it drifts and needs fewer early resets over time. The how and why are in the drift section above.

**Reset reminder**:\
The home screen estimates how far each tracker has likely drifted since its last reset, as drift rate times minutes elapsed, and raises a small banner naming the worst tracker once that crosses about twelve degrees. It clears itself on the next reset and can be dismissed until then. It is a nudge based on each tracker's measured behavior, not a fixed timer.

**Fallback tracking**:\
When a tracker dies or is turned off while still assigned to a body part, that part stays live and is driven by an estimate from the trackers that are still working. A dead thigh follows the shin, a dead spine part follows the rest of the spine. The SteamVR role stays connected and keeps receiving the estimated pose, so you are replacing a dead tracker rather than losing a limb mid session. The home screen marks such a tracker as in fallback and shows the estimated rotation. On by default.

**Emulated trackers**:\
The app can estimate extra tracking points from your physical trackers, presenting chest, waist, knees, feet, and elbows as their own trackers even without a physical tracker there. It is gated so you need at least two trackers below the knee before leg emulation turns on, because the leg estimate needs that anchor. There is an optional straight leg mode. Emulated points go out over SteamVR and over VRChat OSC, and there is a dedicated page plus a settings page that spells out what is real and what is estimated. (Funny thing, SteamVR only allows 10 devices and VRC OSC only allows 8. "20 point tracking" isn't possible for VRChat and SteamVR)

**Automatic realign on reconnect**:\
A calibrated tracker that drops and comes back is scheduled for a yaw realignment instead of a hand recalibration, after a short settle delay so a just powered, possibly warm tracker's fusion can converge before the reset captures a reference.

**Stay Aligned improvements**:\
Correction authority scales with each tracker's measured drift, the locked baseline is kept across brief movements so settling back after a small shift re-locks to the original yaw instead of baking in drift, and the correction ceiling was raised so a badly drifting tracker can be brought back fast.

**Prediction and adaptive smoothing**:\
The rotation filter was reworked as described above: speed scaled smoothing, packet loss adaptive smoothing, clamped angular velocity prediction, and use of the firmware's measured angular velocity when available.

**Network page and always on diagnostics**:\
A networking settings page shows, per tracker, 2.4 GHz signal, ping, packet loss, packets lost versus received, update rate, status, and an overall connection health, plus a session log of every disconnect and reconnect with the reason, including the freeze case where a tracker stays connected but stops ticking. Alongside it a diagnostics block is always on and written as raw numbers, not advice: delivering count, watch time, drop count and rate, average and worst signal, ping, loss and rate with the tracker each worst case belongs to, hottest tracker, lowest battery, and per tracker drop counts, each tinted by threshold. The point is to show the real figures for the setup in front of you, since most choppiness on these trackers is the 2.4 GHz link rather than the software.

**Calibration quality verdict**:\
The diagnostics page shows a per tracker Good, Fair, or Poor verdict synthesized from drift rate, battery, temperature, and packet loss, naming the likely cause when it is not Good.

**Lying down**:\
Stay Aligned's centering force pauses whenever you are not clearly upright, while the locked anti drift force keeps running. Setting on by default.

**Leg behavior**:\
Floor plant and foot handling were smoothed so lifting a planted foot eases off instead of snapping, and a floor independent check recognizes lying down even when the floor estimate is unhelpful.

**Head and body coupling**:\
Body yaw is taken from the spine when a spine tracker is present, while the head keeps its own pitch and roll, so turning your head no longer drags the body. The head pose sent to SteamVR is unchanged.

**Simulated toes**:\
When sending a full skeleton over VMC, simulated toe bones are produced from the foot angle so avatars with toe bones get a little articulation.\
(Why did I add this.)

## Disclaimer

VoidReality is an edited and rebranded build of the SlimeVR server. It is not produced, endorsed, or supported by the SlimeVR project. The original [SlimeVR server](https://github.com/SlimeVR/SlimeVR-Server) is the work of [Eiren Rain](https://github.com/Eirenliel) and the [SlimeVR contributors](https://github.com/SlimeVR/SlimeVR-Server/graphs/contributors?from=3%2F21%2F2026) under the MIT and Apache 2.0 licenses kept in this directory. All credit for the underlying tracking server goes to them. Any problems with this build are not their responsibility. If you want the original, supported software, go to the [SlimeVR project](https://github.com/SlimeVR).
