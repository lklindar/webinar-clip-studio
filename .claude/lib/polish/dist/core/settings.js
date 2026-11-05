"use strict";
// Settings bundles. A preset is just a full Settings object; users can tweak and save their own.
Object.defineProperty(exports, "__esModule", { value: true });
exports.EXPORT_AUDIO_BITRATE = exports.PRESETS = void 0;
exports.cloneSettings = cloneSettings;
exports.outputSize = outputSize;
exports.exportVideoBitrate = exportVideoBitrate;
const fillers_1 = require("./fillers");
const baseExport = { resolution: '1080p', bitrateMbps: 12, fadeMs: 15, softCutMs: 150 };
const baseFillers = {
    enabled: true,
    minConfidence: 0.6,
    lexicon: fillers_1.DEFAULT_LEXICON,
    softLexicon: fillers_1.DEFAULT_SOFT_LEXICON,
    acoustic: true,
    paddingSec: 0.03,
    removeRepeats: true,
    trimHeldWords: true,
};
const baseTranscription = { model: 'base', language: 'auto', prompt: fillers_1.DISFLUENT_PROMPT };
const baseZoom = { enabled: true, scale: 1.8, minConfidence: 0.55, followCursor: true, motionBlur: false, ripple: true };
const baseCaptions = { enabled: true, maxCharsPerLine: 42, maxLines: 2, highlightWord: true, size: 0.042 };
exports.PRESETS = {
    premium: {
        label: 'Premium',
        blurb: 'Everything at moderate strength.',
        settings: {
            silence: {
                enabled: true,
                minSilenceSec: 0.35,
                paddingSec: 0.1,
                thresholdRatio: 0.4,
                speedUpBusy: true,
                minSpeed: 3,
                maxSpeed: 12,
                speedUpTargetSec: 0.8,
                trimDeadAir: true,
            },
            fillers: baseFillers,
            transcription: baseTranscription,
            captions: baseCaptions,
            zoom: baseZoom,
            export: baseExport,
        },
    },
};
function cloneSettings(s) {
    return structuredClone(s);
}
/** Output frame size for an export resolution, keeping the source aspect and even dimensions. */
function outputSize(src, res) {
    const targetH = res === '4k' ? 2160 : res === '1080p' ? 1080 : src.height;
    const scale = targetH / src.height;
    const even = (v) => Math.max(2, Math.round(v / 2) * 2);
    return { width: even(src.width * scale), height: even(targetH) };
}
/** Video bitrate (bits/s) for an export: the setting is for 1080p30, scaled by pixels and frame rate. */
function exportVideoBitrate(bitrateMbps, size, fps) {
    const pixelsScale = (size.width * size.height) / (1920 * 1080);
    return Math.round(bitrateMbps * 1e6 * Math.max(0.5, pixelsScale) * (fps / 30));
}
/** Audio bitrate of the export (bits/s). */
exports.EXPORT_AUDIO_BITRATE = 160_000;
