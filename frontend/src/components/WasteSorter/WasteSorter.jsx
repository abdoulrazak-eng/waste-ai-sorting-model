import { useRef, useState, useEffect, useCallback } from "react";
import styles from "./WasteSorter.module.css";

// ---- Config ----
const API_BASE = "http://127.0.0.1:8000";
const CATEGORIES = ["e-waste", "hazardous", "recycle", "landfill", "compost"];
const CONFIDENCE_THRESHOLD = 50;


const CATEGORY_META = {
  "compost": { icon: "🌱", diverts: true },
  "recycle": { icon: "♻️", diverts: true },
  "e-waste": { icon: "💻", diverts: true },
  "hazardous": { icon: "⚠️", diverts: true },
  "landfill": { icon: "🗑️", diverts: false },
  "uncertain": { icon: "❓", diverts: false },
};

// Sound files are organized per-language: /src/assets/sounds/<lang>/<category>.mp3
const LANGUAGES = [
  { code: "english", label: "English" },
  { code: "rwanda", label: "Kinyarwanda" },
  { code: "french", label: "Français" },
];

const CATEGORY_SOUND_FILE = {
  "compost": "green.mp3",
  "recycle": "blue.mp3",
  "e-waste": "purple.mp3",
  "hazardous": "red.mp3",
  "landfill": "grey.mp3",
  "uncertain": "uncertain.mp3"
};

const CAPTURE_LABELS = {
  english: "Do you have trash? Show in the box",
  rwanda: "Ufite imyanda? Yerekane mu gasanduku",
  french: "Avez-vous des déchets ? Montrez-les dans la boîte",
};

// Rough impact estimate: kg of CO2e avoided per item kept out of landfill.
const CO2_PER_DIVERTED_ITEM_KG = 0.3;

// ---- Auto-capture (frame differencing) config ----
const DETECT_W = 160; // low-res analysis buffer, 4:3 to match video
const DETECT_H = 120;
const DIFF_THRESHOLD = 28; // per-pixel RGB delta considered "changed"
const ENTER_RATIO = 0.035; // % of changed pixels to count as "object present"
const EXIT_RATIO = 0.015; // % below which the frame is considered "empty" again
const STABLE_FRAMES_REQUIRED = 8; // consecutive detecting frames before capture
const EMPTY_FRAMES_TO_RECALIBRATE = 6; // consecutive empty frames before refreshing bg
const COOLDOWN_MS = 2500; // pause after a capture before scanning again
const BBOX_PADDING = 0.18; // extra margin around the carved-out object, as % of size
const DETECT_INTERVAL_MS = 150;

// Keys match CATEGORY_META (dash-separated) so both stay in sync from one source of truth.
const CLASS_COLORS = {
  compost: '#5fd07a',
  recycle: '#4fa3f7',
  hazardous: '#ff5a5f',
  'e-waste': '#b58cff',
  landfill: '#8e97a3',
  uncertain: '#d9a441',
};

// Normalizes "e_waste" / "E-Waste" / "e-waste" -> "e-waste" so API responses
// (which may use underscores or different casing) match CATEGORY_META keys.
const normalizeCategory = (raw) => {
  if (!raw) return null;
  return String(raw).toLowerCase().trim().replace(/_/g, "-");
};

export default function WasteSorter() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const detectCanvasRef = useRef(null);

  const [cameraReady, setCameraReady] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState(null);
  const [lastResult, setLastResult] = useState(null);
  const [items, setItems] = useState([]); // raw records from /get_sorted

  // ---- Auto-capture state ----
  const [autoMode, setAutoMode] = useState(false);
  const [autoStatus, setAutoStatus] = useState("idle"); // idle | empty | detecting | holding | captured

  // ---- Category popup + aspect ratio state ----
  const [showCategoryPopup, setShowCategoryPopup] = useState(false);
  const [popupCategory, setPopupCategory] = useState(null);
  // true = 4:3 kiosk (compact card layout), false = 16:9 dashboard console view
  const [kioskAspect, setKioskAspect] = useState(true);
  const popupTimeoutRef = useRef(null);

  // ---- Voice language ----
  const [language, setLanguage] = useState("english");

  // Mutable detection state (kept out of React state so the ~7fps loop
  // doesn't trigger re-renders on every tick)
  const bgFrameRef = useRef(null); // ImageData baseline ("empty box") to diff against
  const stableFramesRef = useRef(0);
  const emptyStreakRef = useRef(0);
  const cooldownRef = useRef(false);
  const lastBBoxRef = useRef(null); // {minX, minY, maxX, maxY} in detect-canvas coords
  const [lastImageB64, setLastImageB64] = useState(null);
  const [feedbackState, setFeedbackState] = useState("idle"); // idle | choosing | sent
  const [correctionCategory, setCorrectionCategory] = useState("");

  const blobToBase64 = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result.split(",")[1]); // strip data: prefix
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });

  const sendFeedback = async (label) => {
    if (!lastImageB64 || !lastResult) return;
    try {
      await fetch(`${API_BASE}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          image: lastImageB64,
          confidence: lastResult.confidence,
          label,
        }),
      });
      setFeedbackState("sent");
    } catch (err) {
      setError(err.message);
    }
  };

  const handleThumbsUp = () => {
    sendFeedback(lastResult.category);
  };

  const handleThumbsDown = () => {
    setFeedbackState("choosing");
  };

  const submitCorrection = () => {
    if (!correctionCategory) return;
    sendFeedback(correctionCategory);
  };
  // ---- Attach the live stream to whichever <video> node is currently
  // mounted. Kiosk and dashboard views are separate render branches, so
  // switching between them unmounts one <video> element and mounts a new
  // one; a one-time effect on mount would miss that. This callback ref
  // re-attaches the stream every time a new node shows up. ----
  const attachVideoRef = useCallback((node) => {
    videoRef.current = node;
    if (node && streamRef.current) {
      node.srcObject = streamRef.current;
      // srcObject swaps don't always auto-resume playback
      node.play?.().catch(() => {});
    }
  }, []);
  const audioRef = useRef(null);

  const playCategorySound = useCallback(
    (cat) => {
      const file = CATEGORY_SOUND_FILE[cat];
      if (!file) {
        console.log("no sound file for category", cat);
        return;
      }
      const src = `/sounds/${language}/${file}`;

      if (!audioRef.current) {
        audioRef.current = new Audio();
      }
      audioRef.current.src = src;
      audioRef.current.currentTime = 0;
      audioRef.current.play().catch((err) => {
        console.warn("Sound playback blocked:", err.message);
      });
    },
    [language]
  );
  // ---- Start camera on mount ----
  useEffect(() => {
    let cancelled = false;

    async function startCamera() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", aspectRatio: { ideal: 16 / 9 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        setCameraReady(true);
      } catch (err) {
        setError("Could not access camera: " + err.message);
      }
    }

    startCamera();

    return () => {
      cancelled = true;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  // ---- Clear any pending popup timeout on unmount ----
  useEffect(() => {
    return () => clearTimeout(popupTimeoutRef.current);
  }, []);

  // ---- Lock page scroll while in the dashboard console view ----
  useEffect(() => {
    if (!kioskAspect) {
      const prevOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = prevOverflow;
      };
    }
  }, [kioskAspect]);

  // ---- Fetch sorted results (counts) ----
  const fetchSorted = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/get_sorted`, {
        method: "GET",
        headers: { accept: "application/json" },
      });
      if (!res.ok) throw new Error(`GET /get_sorted failed: ${res.status}`);
      const json = await res.json();
      setItems(json.data || []);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  // Load counts once on mount too, so the dashboard isn't empty before first scan
  useEffect(() => {
    fetchSorted();
  }, [fetchSorted]);

  // ---- Capture frame from video -> Blob. Pass a bbox {x,y,width,height}
  // (full-resolution video pixel coords) to carve out just that region,
  // otherwise the whole frame is captured. ----
  const captureFrame = (bbox) =>
    new Promise((resolve, reject) => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas) return reject(new Error("Camera not ready"));

      if (bbox) {
        canvas.width = bbox.width;
        canvas.height = bbox.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(
          video,
          bbox.x,
          bbox.y,
          bbox.width,
          bbox.height,
          0,
          0,
          bbox.width,
          bbox.height
        );
      } else {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      }

      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error("Failed to capture frame"));
        },
        "image/jpeg",
        0.92
      );
    });

  // ---- Send captured frame to /inference ----
  const sendToInference = async (blob) => {
    const formData = new FormData();
    formData.append("frame", blob, "frame.jpg");

    const res = await fetch(`${API_BASE}/inference`, {
      method: "POST",
      headers: { accept: "application/json" }, // don't set Content-Type manually; browser sets multipart boundary
      body: formData,
    });

    if (!res.ok) {
      throw new Error(`POST /inference failed: ${res.status}`);
    }
    return res.json();
  };

  // ---- Shared: send a captured blob to /inference and update state ----
  const runInference = async (blob) => {
    setError(null);
    setScanning(true);
    setLastResult(null);
    setFeedbackState("idle");
    setCorrectionCategory("");

    try {
      const b64 = await blobToBase64(blob);
      setLastImageB64(b64);

      const result = await sendToInference(blob);
      const confidence = result.conf;
      const modelCat = normalizeCategory(result.class);
      const isConfident = confidence === null || confidence >= CONFIDENCE_THRESHOLD;
      const cat = isConfident && CATEGORY_META[modelCat] ? modelCat : "uncertain";

      setLastResult({ category: result.class, confidence });
      setPopupCategory(cat);
      setShowCategoryPopup(true);
      clearTimeout(popupTimeoutRef.current);
      popupTimeoutRef.current = setTimeout(() => setShowCategoryPopup(false), 2600);
      playCategorySound(cat);

      await fetchSorted();
    } catch (err) {
      setError(err.message);
    } finally {
      setScanning(false);
    }
  };
  // ---- Manual scan button handler ----
  const handleScan = async () => {
    try {
      const blob = await captureFrame();
      await runInference(blob);
    } catch (err) {
      setError(err.message);
    }
  };

  // ---- Convert a bbox in low-res detection coords to full video pixel
  // coords, adding padding so we don't crop the object too tight ----
  const scaleBBoxToVideo = (bbox) => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return null;

    const scaleX = video.videoWidth / DETECT_W;
    const scaleY = video.videoHeight / DETECT_H;

    let x = bbox.minX * scaleX;
    let y = bbox.minY * scaleY;
    let width = (bbox.maxX - bbox.minX) * scaleX;
    let height = (bbox.maxY - bbox.minY) * scaleY;

    const padX = width * BBOX_PADDING;
    const padY = height * BBOX_PADDING;

    x = Math.max(0, x - padX);
    y = Math.max(0, y - padY);
    width = Math.min(video.videoWidth - x, width + padX * 2);
    height = Math.min(video.videoHeight - y, height + padY * 2);

    if (width < 8 || height < 8) return null;
    return { x, y, width, height };
  };

  // ---- Fires once an object has been stably in view for
  // STABLE_FRAMES_REQUIRED ticks: carve it out and send to inference ----
  const triggerAutoCapture = useCallback(async (detectBBox) => {
    cooldownRef.current = true;
    setAutoStatus("captured");

    try {
      const bbox = scaleBBoxToVideo(detectBBox);
      const blob = await captureFrame(bbox || undefined);
      await runInference(blob);
    } catch (err) {
      setError(err.message);
    } finally {
      // Give the user a moment to pull the item back out, then recalibrate
      // the background and resume watching for the next object.
      setTimeout(() => {
        bgFrameRef.current = null;
        stableFramesRef.current = 0;
        emptyStreakRef.current = 0;
        cooldownRef.current = false;
        setAutoStatus("empty");
      }, COOLDOWN_MS);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Detection tick: grab a low-res frame, diff it against the stored
  // "empty box" baseline, and track how much of the frame changed + where ----
  const detectTick = useCallback(() => {
    const video = videoRef.current;
    const dcanvas = detectCanvasRef.current;
    if (!video || !dcanvas || video.readyState < 2 || cooldownRef.current) return;

    dcanvas.width = DETECT_W;
    dcanvas.height = DETECT_H;
    const ctx = dcanvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, DETECT_W, DETECT_H);
    const frame = ctx.getImageData(0, 0, DETECT_W, DETECT_H);

    if (!bgFrameRef.current) {
      // Establish (or re-establish) the empty-box baseline
      bgFrameRef.current = frame;
      setAutoStatus("empty");
      return;
    }

    const bg = bgFrameRef.current.data;
    const cur = frame.data;
    let changed = 0;
    let minX = DETECT_W, minY = DETECT_H, maxX = 0, maxY = 0;

    for (let y = 0; y < DETECT_H; y++) {
      for (let x = 0; x < DETECT_W; x++) {
        const i = (y * DETECT_W + x) * 4;
        const diff =
          (Math.abs(cur[i] - bg[i]) +
            Math.abs(cur[i + 1] - bg[i + 1]) +
            Math.abs(cur[i + 2] - bg[i + 2])) /
          3;

        if (diff > DIFF_THRESHOLD) {
          changed++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    const ratio = changed / (DETECT_W * DETECT_H);

    if (ratio >= ENTER_RATIO) {
      lastBBoxRef.current = { minX, minY, maxX, maxY };
      emptyStreakRef.current = 0;
      stableFramesRef.current += 1;
      setAutoStatus(
        stableFramesRef.current >= STABLE_FRAMES_REQUIRED ? "holding" : "detecting"
      );

      if (stableFramesRef.current === STABLE_FRAMES_REQUIRED) {
        triggerAutoCapture(lastBBoxRef.current);
      }
    } else {
      stableFramesRef.current = 0;
      if (ratio < EXIT_RATIO) {
        emptyStreakRef.current += 1;
        setAutoStatus("empty");
        // Periodically refresh the baseline while stably empty, so slow
        // lighting drift doesn't cause false positives later.
        if (emptyStreakRef.current === EMPTY_FRAMES_TO_RECALIBRATE) {
          bgFrameRef.current = frame;
        }
      } else {
        setAutoStatus("idle");
      }
    }
  }, [triggerAutoCapture]);

  // ---- Run the detection loop while Auto Mode is on ----
  useEffect(() => {
    if (!autoMode || !cameraReady) return;

    bgFrameRef.current = null;
    stableFramesRef.current = 0;
    emptyStreakRef.current = 0;
    cooldownRef.current = false;
    setAutoStatus("empty");

    const id = setInterval(detectTick, DETECT_INTERVAL_MS);
    return () => clearInterval(id);
  }, [autoMode, cameraReady, detectTick]);

  // ---- Aggregate counts per category ----
  const counts = CATEGORIES.reduce((acc, cat) => {
    acc[cat] = items.filter((i) => i.category === cat).length;
    return acc;
  }, {});

  const totalItems = items.length;
  const maxCount = Math.max(1, ...CATEGORIES.map((c) => counts[c]));

  // ---- Impact metrics ----
  const divertedCount = CATEGORIES
    .filter((c) => CATEGORY_META[c].diverts)
    .reduce((sum, c) => sum + counts[c], 0);

  const landfillCount = counts["landfill"] || 0;
  const recyclingRate = totalItems > 0 ? Math.round((divertedCount / totalItems) * 100) : 0;
  const co2AvoidedKg = (divertedCount * CO2_PER_DIVERTED_ITEM_KG).toFixed(1);

  const autoStatusLabel = {
    idle: "Auto mode ready",
    empty: "Watching for an item…",
    detecting: "Object detected — hold steady",
    holding: "Locking on…",
    captured: "Captured! Analyzing…",
  }[autoStatus];

  // ---- Shared: single category readout, rendered differently per view ----
  const renderCategoryTile = (cat, variant) =>
    variant === "meter" ? (
      <div key={cat} className={styles.meterCard} data-category={cat}>
        <div className={styles.meterTop}>
          <span className={styles.meterIcon}>{CATEGORY_META[cat].icon}</span>
          <span className={styles.meterName}>{cat}</span>
        </div>
        <div className={styles.meterCount}>{counts[cat]}</div>
        <div className={styles.meterBarTrack}>
          <div
            className={styles.meterBarFill}
            style={{ height: `${(counts[cat] / maxCount) * 100}%` }}
          />
        </div>
      </div>
    ) : (
      <div key={cat} className={styles.card} data-category={cat}>
        <div className={styles.cardTop}>
          <span className={styles.cardCategory}>{cat}</span>
          <span className={styles.cardIcon}>{CATEGORY_META[cat].icon}</span>
        </div>
        <div className={styles.cardCount}>{counts[cat]}</div>
        <div className={styles.cardBarTrack}>
          <div
            className={styles.cardBarFill}
            style={{ width: `${(counts[cat] / maxCount) * 100}%` }}
          />
        </div>
      </div>
    );

  const renderImpactPanel = () => (
    <div className={styles.impactPanel}>
      <div className={styles.impactRow}>
        <span className={styles.impactLabel}>Diverted from landfill</span>
        <span className={`${styles.impactValue} ${styles.accentValue}`}>{divertedCount}</span>
      </div>
      <div className={styles.impactRow}>
        <span className={styles.impactLabel}>Recycling rate</span>
        <span className={styles.impactValue}>{recyclingRate}%</span>
      </div>
      <div className={styles.impactRow}>
        <span className={styles.impactLabel}>CO₂e avoided (est.)</span>
        <span className={`${styles.impactValue} ${styles.amberValue}`}>{co2AvoidedKg} kg</span>
      </div>
      <div className={styles.impactRow}>
        <span className={styles.impactLabel}>Sent to landfill</span>
        <span className={styles.impactValue}>{landfillCount}</span>
      </div>
      <p className={styles.impactFootnote}>
        Estimate: ~{CO2_PER_DIVERTED_ITEM_KG} kg CO₂e avoided per item kept out of landfill.
      </p>
    </div>
  );

  const renderLanguageSelect = (extraClass) => (
    <select
      className={`${styles.languageSelect} ${extraClass || ""}`}
      value={language}
      onChange={(e) => setLanguage(e.target.value)}
      title="Voice language"
    >
      {LANGUAGES.map((l) => (
        <option key={l.code} value={l.code}>
          {l.label}
        </option>
      ))}
    </select>
  );

  const renderVideoStage = () => (
    <div
      className={styles.videoWrap}
      onClick={() => setKioskAspect(true)}
      title={kioskAspect ? "Tap to expand" : "Tap to return to kiosk view"}
    >
      <video ref={attachVideoRef} autoPlay playsInline muted className={styles.video} />
      <canvas ref={canvasRef} className={styles.canvas} />
      <canvas ref={detectCanvasRef} className={styles.canvas} />

      <div className={`${styles.scanOverlay} ${scanning ? styles.scanningActive : ""}`}>
        <span className={`${styles.corner} ${styles.tl}`} />
        <span className={`${styles.corner} ${styles.tr}`} />
        <span className={`${styles.corner} ${styles.bl}`} />
        <span className={`${styles.corner} ${styles.br}`} />
        <span className={styles.scanline} />
      </div>


      <div className={`${styles.statusBadge} ${scanning ? styles.busy : cameraReady ? styles.live : ""}`}>
        <span className={styles.statusDot} />
        {scanning ? "Analyzing" : cameraReady ? "Camera live" : "Connecting"}
      </div>

      {autoMode && (
        <div
          className={`${styles.autoBadge} ${
            autoStatus === "detecting" || autoStatus === "holding" ? styles.autoBadgeActive : ""
          }`}
        >
          {autoStatusLabel}
        </div>
      )}

      {showCategoryPopup && popupCategory && (
        <div className={styles.categoryPopup} style={{ "--popup-color": CLASS_COLORS[popupCategory] }}>
          <span className={styles.categoryPopupIcon}>{CATEGORY_META[popupCategory].icon}</span>
          <span className={styles.categoryPopupName}>{popupCategory}</span>
        </div>
      )}

      <button
        className={styles.aspectToggleBtn}
        onClick={(e) => {
          e.stopPropagation();
          setKioskAspect((v) => !v);
        }}
        title={kioskAspect ? "Expand view" : "Kiosk view"}
      >
        {kioskAspect ? "⤢" : "⤡"}
      </button>
    </div>
  );

  const renderControls = () => (
    <div className={styles.controls}>
      <button onClick={handleScan} disabled={!cameraReady || scanning || autoMode} className={styles.button}>
        {scanning ? "Scanning…" : "Scan Item"}
      </button>
      <button
        onClick={() => setAutoMode((v) => !v)}
        disabled={!cameraReady}
        className={`${styles.toggleButton} ${autoMode ? styles.toggleButtonActive : ""}`}
      >
        <span className={styles.toggleDot} />
        Auto Mode
      </button>
    </div>
  );

  const renderLastResult = () =>
    lastResult && (
      <div className={styles.resultBox}>
        <span className={styles.resultLabel}>Last scan result</span>
        <div className={styles.pre}>
          {Object.entries(lastResult).map(([key, value]) => {
            let displayValue = value;
            let valueStyle = {};

            if (CLASS_COLORS[normalizeCategory(value)]) {
              valueStyle = { color: CLASS_COLORS[normalizeCategory(value)], fontWeight: 600 };
            } else if (typeof value === "number") {
              displayValue = `${Math.round(value)}%`;
              valueStyle = { color: "var(--text-muted)" };
            }

            return (
              <div key={key} style={{ display: "flex", gap: "8px", marginBottom: "2px" }}>
                <span style={{ color: "var(--text-muted)" }}>{key}:</span>
                <span style={valueStyle}>{JSON.stringify(displayValue)}</span>
              </div>
            );
          })}
        </div>

        {feedbackState !== "sent" ? (
          <div className={styles.feedbackRow}>
            {feedbackState !== "choosing" ? (
              <>
                <span className={styles.feedbackPrompt}>Was this right?</span>
                <button
                  className={styles.feedbackBtn}
                  onClick={handleThumbsUp}
                  aria-label="Correct"
                  title="Correct"
                >
                  👍
                </button>
                <button
                  className={styles.feedbackBtn}
                  onClick={handleThumbsDown}
                  aria-label="Incorrect"
                  title="Incorrect"
                >
                  👎
                </button>
              </>
            ) : (
              <div className={styles.correctionRow}>
                <select
                  className={styles.correctionSelect}
                  value={correctionCategory}
                  onChange={(e) => setCorrectionCategory(e.target.value)}
                >
                  <option value="" disabled>
                    Select correct category
                  </option>
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <button
                  className={styles.correctionSubmitBtn}
                  onClick={submitCorrection}
                  disabled={!correctionCategory}
                >
                  Submit
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className={styles.feedbackThanks}>Thanks — this helps!</div>
        )}
      </div>
    );

  // ==================================================================
  // View 1: Dashboard / operator console (16:9)
  // ==================================================================
  if (!kioskAspect) {
    return (
      <div className={styles.dashboard}>
        <div className={styles.dashboardTopBar}>
          <div>
            <p className={styles.eyebrow}>Smart Bin · Station 01</p>
            <h2 className={styles.heading}>
              SmartEco <span className={styles.brandInline}>CT</span>
            </h2>
          </div>
          <div className={styles.sessionStats}>
            {renderLanguageSelect()}
            <div className={styles.sessionStat}>
              <span className={styles.sessionStatValue}>{totalItems}</span>
              <span className={styles.sessionStatLabel}>items logged</span>
            </div>
            <div className={styles.sessionStat}>
              <span className={styles.sessionStatValue}>{recyclingRate}%</span>
              <span className={styles.sessionStatLabel}>diverted</span>
            </div>
            <button className={styles.collapseBtn} onClick={() => setKioskAspect(true)} title="Back to kiosk view">
              ⤡ Kiosk view
            </button>
          </div>
        </div>

        <div className={styles.dashboardBody}>
          <div className={styles.dashboardVideoCol}>
            <div className={styles.dashboardShell}>
              <div className={`${styles.eyes} ${scanning ? styles.eyesScanning : ""}`}>
                <span className={styles.eye}>
                  <span className={styles.pupil} />
                </span>
                <span className={styles.eye}>
                  <span className={styles.pupil} />
                </span>
              </div>
              <div className={styles.captureLabel}>{CAPTURE_LABELS[language]}</div>
              {renderVideoStage()}
              {renderControls()}
            </div>
            {error && <div className={styles.error}>{error}</div>}
          </div>

          <div className={styles.dashboardSidebar}>
            <div className={styles.dashboardSidebarMain}>
              <h3 className={styles.subheadingRail}>Category Counts</h3>
              <div className={styles.meterRail}>
                {CATEGORIES.map((cat) => renderCategoryTile(cat, "meter"))}
              </div>

              <h3 className={styles.subheadingRail}>Impact</h3>
              {renderImpactPanel()}
            </div>

            <div className={styles.dashboardSidebarFooter}>
              {lastResult && (
                <div className={styles.dashboardLastResult}>
                  <span className={styles.resultLabel}>Last scan</span>
                  <span className={styles.dashboardLastResultValue}>
                    {normalizeCategory(lastResult.category) || "—"}
                  </span>
                </div>
              )}
              <button onClick={fetchSorted} className={styles.refreshButton}>
                Refresh counts
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ==================================================================
  // View 2: Kiosk (4:3)
  // ==================================================================
  return (
    <div className={styles.container}>
      <div className={styles.headerRow}>
        <div>
          <p className={styles.eyebrow}>Smart Bin · Station 01</p>
          <h2 className={styles.heading}>
            SmartEco Smart Waste Sorting <span className={styles.brandInline}>CT</span>
          </h2>
        </div>
        {renderLanguageSelect()}
      </div>

      <div className={styles.kioskShell}>
        <div className={`${styles.eyes} ${scanning ? styles.eyesScanning : ""}`}>
          <span className={styles.eye}>
            <span className={styles.pupil} />
          </span>
          <span className={styles.eye}>
            <span className={styles.pupil} />
          </span>
        </div>

        <div className={styles.captureLabel}>{CAPTURE_LABELS[language]}</div>

        {renderVideoStage()}
        {renderControls()}
      </div>

      {error && <div className={styles.error}>{error}</div>}
      {renderLastResult()}

      <h3 className={styles.subheading}>Category Counts</h3>
      <div className={styles.grid}>
        {CATEGORIES.map((cat) => renderCategoryTile(cat, "card"))}
      </div>

      <h3 className={styles.subheading}>Impact of Sorting</h3>
      {renderImpactPanel()}

      <button onClick={fetchSorted} className={styles.refreshButton}>
        Refresh counts
      </button>
    </div>
  );
}