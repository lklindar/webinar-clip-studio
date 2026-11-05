"use strict";
// Compact per-frame output of the frame-analysis worker. Everything is in analysis pixels (the
// worker runs at `scale` × source resolution); consumers convert to source pixels.
Object.defineProperty(exports, "__esModule", { value: true });
exports.CHANGE_FIELDS = exports.CHANGE_SLOTS = exports.CURSOR_FIELDS = exports.CURSOR_SLOTS = void 0;
exports.CURSOR_SLOTS = 4;
exports.CURSOR_FIELDS = 5;
exports.CHANGE_SLOTS = 6;
exports.CHANGE_FIELDS = 5;
