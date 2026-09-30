// js/waveform.js

const MAX_DECODE_BYTES = 120 * 1024 * 1024;

export class WaveformGenerator {
    constructor() {
        this.cache = new Map();
        this.sampleCache = new Map();
        this.generatedCache = new Map();
        this.pendingGenerations = new Map();
    }

    async loadWaveformData(waveformObj, trackId) {
        if (!waveformObj) return null;
        if (trackId && this.sampleCache.has(trackId)) {
            return this.sampleCache.get(trackId);
        }

        let samples = Array.isArray(waveformObj.samples) ? waveformObj.samples : null;
        let pngUrl = waveformObj.png_url || waveformObj.pngUrl || null;
        let jsonUrl = waveformObj.json_url || waveformObj.jsonUrl || null;
        let durationMs = Number(waveformObj.duration_ms ?? waveformObj.durationMs) || null;

        if (!samples && jsonUrl) {
            try {
                const response = await fetch(jsonUrl);
                if (response.ok) {
                    const json = await response.json();
                    if (Array.isArray(json.samples)) {
                        samples = json.samples;
                    }
                    durationMs = Number(json.duration_ms ?? json.durationMs) || durationMs;
                }
            } catch (e) {
                console.warn('Failed to load waveform JSON:', e);
            }
        }

        const result = {
            pngUrl,
            jsonUrl,
            samples,
            durationSeconds: durationMs && durationMs > 0 ? durationMs / 1000 : null,
        };
        if (trackId) {
            this.sampleCache.set(trackId, result);
        }
        return result;
    }

    invertWaveformMaskAlpha(data) {
        if (!data) return data;
        for (let i = 0; i < data.length; i += 4) {
            data[i] = 0;
            data[i + 1] = 0;
            data[i + 2] = 0;
            data[i + 3] = 255 - data[i + 3];
        }
        return data;
    }

    async decodeImage(blob) {
        if (typeof createImageBitmap === 'function') {
            try {
                return await createImageBitmap(blob);
            } catch {
                // Fall back for Safari versions with partial ImageBitmap PNG support.
            }
        }

        const objectUrl = URL.createObjectURL(blob);
        try {
            return await new Promise((resolve, reject) => {
                const image = new Image();
                image.onload = () => resolve(image);
                image.onerror = () => reject(new Error('Unable to decode waveform image'));
                image.src = objectUrl;
            });
        } finally {
            URL.revokeObjectURL(objectUrl);
        }
    }

    async loadWaveformPngAsAlphaMask(pngUrl, targetWidth = 1000, targetHeight = 28) {
        if (!pngUrl) return null;
        let image = null;

        try {
            const response = await fetch(pngUrl);
            if (!response.ok) return null;
            image = await this.decodeImage(await response.blob());

            const canvas = document.createElement('canvas');
            canvas.width = targetWidth;
            canvas.height = targetHeight;
            const context = canvas.getContext('2d');
            if (!context) return null;

            context.drawImage(image, 0, 0, targetWidth, targetHeight);
            const imageData = context.getImageData(0, 0, targetWidth, targetHeight);
            this.invertWaveformMaskAlpha(imageData.data);
            context.putImageData(imageData, 0, 0);
            return this.createMaskImageUrl(canvas);
        } catch (error) {
            console.warn('Unable to convert SoundCloud waveform mask:', error);
            return null;
        } finally {
            if (typeof image?.close === 'function') image.close();
        }
    }

    async loadWaveformPngSamples(pngUrl, targetWidth = 500, targetHeight = 140) {
        if (!pngUrl) return null;
        let image = null;

        try {
            const response = await fetch(pngUrl);
            if (!response.ok) return null;
            image = await this.decodeImage(await response.blob());

            const canvas = document.createElement('canvas');
            canvas.width = targetWidth;
            canvas.height = targetHeight;
            const context = canvas.getContext('2d');
            if (!context) return null;

            context.drawImage(image, 0, 0, targetWidth, targetHeight);
            const pixels = context.getImageData(0, 0, targetWidth, targetHeight).data;
            const samples = new Array(targetWidth).fill(0);
            for (let x = 0; x < targetWidth; x++) {
                let transparentPixels = 0;
                for (let y = 0; y < targetHeight; y++) {
                    if (pixels[(y * targetWidth + x) * 4 + 3] < 128) transparentPixels++;
                }
                samples[x] = Math.round((transparentPixels / targetHeight) * 255);
            }
            return samples;
        } catch (error) {
            console.warn('Unable to extract SoundCloud waveform samples:', error);
            return null;
        } finally {
            if (typeof image?.close === 'function') image.close();
        }
    }

    createMaskImageUrl(canvas) {
        if (!canvas || typeof canvas.toDataURL !== 'function') return null;
        const dataUrl = canvas.toDataURL('image/png');
        if (!dataUrl?.startsWith('data:image/png') || dataUrl.length <= 100) return null;
        return dataUrl;
    }

    getSilenceBoundaries(samples, duration, threshold = 5, crossfadeDurationSeconds = 3) {
        if (!Array.isArray(samples) || samples.length === 0 || !duration || duration <= 0) {
            return {
                leadingSilenceSeconds: 0,
                trailingSilenceStartTime: duration || 0,
                crossfadeStartTime: duration || 0,
                crossfadeDurationSeconds: 0,
                hasTrailingSilence: false,
            };
        }

        // Leading silence: find first sample >= threshold
        let firstActiveIndex = 0;
        while (firstActiveIndex < samples.length && samples[firstActiveIndex] < threshold) {
            firstActiveIndex++;
        }

        // Trailing silence: find last sample >= threshold
        let lastActiveIndex = samples.length - 1;
        while (lastActiveIndex >= 0 && samples[lastActiveIndex] < threshold) {
            lastActiveIndex--;
        }

        // If no active sample reached threshold, do not trim whole track
        if (lastActiveIndex < 0 || firstActiveIndex >= samples.length) {
            return {
                leadingSilenceSeconds: 0,
                trailingSilenceStartTime: duration,
                crossfadeStartTime: duration,
                crossfadeDurationSeconds: 0,
                hasTrailingSilence: false,
            };
        }

        const leadingSilenceSeconds = (firstActiveIndex / samples.length) * duration;
        const trailingSilenceStartTime = ((lastActiveIndex + 1) / samples.length) * duration;
        const hasTrailingSilence = duration - trailingSilenceStartTime > 0.5;
        const transitionEndTime = hasTrailingSilence ? trailingSilenceStartTime : duration;
        const availableCrossfadeSeconds = Math.max(
            0,
            Math.min(crossfadeDurationSeconds, transitionEndTime - leadingSilenceSeconds)
        );
        const crossfadeStartTime = transitionEndTime - availableCrossfadeSeconds;

        return {
            leadingSilenceSeconds,
            trailingSilenceStartTime,
            crossfadeStartTime,
            crossfadeDurationSeconds: availableCrossfadeSeconds,
            hasTrailingSilence,
        };
    }

    async getWaveform(url, trackId, { signal } = {}) {
        if (this.cache.has(trackId)) {
            return this.cache.get(trackId);
        }

        try {
            const audioContext = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 44100);
            // tracks.monochrome.st intermittently 500s, and answers the browser's cache
            // revalidation with 500 too, so bypass the HTTP cache and retry server errors.
            let response = null;
            for (let attempt = 0; attempt < 3; attempt++) {
                if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
                response = await fetch(url, { signal, cache: 'no-store' });
                if (response.status < 500) break;
                response.body?.cancel().catch(() => {});
            }
            if (!response?.ok) return null;
            // Decoding holds the whole track as float PCM; skip files that would need hundreds of MB.
            if (Number(response.headers.get('content-length')) > MAX_DECODE_BYTES) {
                response.body?.cancel().catch(() => {});
                return null;
            }
            const arrayBuffer = await response.arrayBuffer();
            const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

            const peaks = this.extractPeaks(audioBuffer);
            const result = { peaks, duration: audioBuffer.duration };
            this.cache.set(trackId, result);
            return result;
        } catch (error) {
            if (error?.name !== 'AbortError') console.warn('Waveform generation failed:', error);
            return null;
        }
    }

    // Fallback for sources that ship no waveform (tracks.monochrome.st): decode the stream
    // itself and render it in the same format as SoundCloud's PNG (black on transparent),
    // so the seekbar and silence detection use it unchanged. Costs a second download.
    async generateFromStream(streamInfo, trackId, { signal } = {}) {
        if (!trackId || streamInfo?.playbackType !== 'direct' || !streamInfo.url) return null;
        let url;
        try {
            url = new URL(streamInfo.url, window.location.href);
        } catch {
            return null;
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

        if (this.generatedCache.has(trackId)) return this.generatedCache.get(trackId);
        if (this.pendingGenerations.has(trackId)) return this.pendingGenerations.get(trackId);

        const generation = (async () => {
            const waveform = await this.getWaveform(url.href, trackId, { signal });
            if (!waveform?.peaks?.length) return null;

            // 400 bars stay distinct at seekbar size; the curve adds contrast to the drawing
            // only, so silence detection keeps the linear levels in `samples`.
            const canvas = document.createElement('canvas');
            canvas.width = 1200;
            canvas.height = 200;
            this.drawWaveform(
                canvas,
                waveform.peaks.map((peak) => peak ** 1.5)
            );
            const result = {
                pngUrl: this.createMaskImageUrl(canvas),
                jsonUrl: null,
                samples: Array.from(waveform.peaks, (peak) => Math.round(peak * 255)),
                durationSeconds: waveform.duration || null,
            };

            this.generatedCache.set(trackId, result);
            if (this.generatedCache.size > 30) {
                this.generatedCache.delete(this.generatedCache.keys().next().value);
            }
            return result;
        })();

        this.pendingGenerations.set(trackId, generation);
        try {
            return await generation;
        } finally {
            this.pendingGenerations.delete(trackId);
        }
    }

    extractPeaks(audioBuffer) {
        const { length, duration } = audioBuffer;
        const numPeaks = Math.min(Math.floor(4 * duration), 1000);
        const peaks = new Float32Array(numPeaks);
        const chanData = audioBuffer.getChannelData(0);
        const step = Math.floor(length / numPeaks);
        const stride = 8;

        // RMS rather than the absolute peak: modern masters hit near-full peaks almost
        // everywhere, which draws as a solid block.
        for (let i = 0; i < numPeaks; i++) {
            let sumSquares = 0;
            let count = 0;
            const start = i * step;
            const end = start + step;
            for (let j = start; j < end; j += stride) {
                const datum = chanData[j];
                sumSquares += datum * datum;
                count++;
            }
            peaks[i] = count > 0 ? Math.sqrt(sumSquares / count) : 0;
        }

        let maxPeak = 0;
        for (let i = 0; i < numPeaks; i++) {
            if (peaks[i] > maxPeak) maxPeak = peaks[i];
        }
        if (maxPeak > 0) {
            for (let i = 0; i < numPeaks; i++) {
                peaks[i] /= maxPeak;
            }
        }

        return peaks;
    }

    drawWaveformFromSamples(canvas, samples) {
        if (!canvas || !Array.isArray(samples) || samples.length === 0) return;

        let maxVal = 0;
        for (let i = 0; i < samples.length; i++) {
            if (samples[i] > maxVal) maxVal = samples[i];
        }
        const normFactor = maxVal > 0 ? maxVal : 140;

        const peaks = new Float32Array(samples.length);
        for (let i = 0; i < samples.length; i++) {
            peaks[i] = samples[i] / normFactor;
        }

        this.drawWaveform(canvas, peaks);
    }

    drawWaveform(canvas, peaks) {
        if (!canvas || !peaks || peaks.length === 0) return;

        const ctx = canvas.getContext('2d');
        const width = canvas.width;
        const height = canvas.height;

        ctx.clearRect(0, 0, width, height);

        const numBars = Math.min(peaks.length, Math.floor(width / 3));
        const samplesPerBar = Math.max(1, Math.floor(peaks.length / numBars));
        const barWidth = Math.max(1.5, (width / numBars) * 0.65);
        const gap = (width / numBars) * 0.35;
        const centerY = height / 2;

        ctx.fillStyle = '#000';

        for (let i = 0; i < numBars; i++) {
            let maxPeak = 0;
            const startIdx = i * samplesPerBar;
            const endIdx = Math.min(startIdx + samplesPerBar, peaks.length);
            for (let j = startIdx; j < endIdx; j++) {
                if (peaks[j] > maxPeak) maxPeak = peaks[j];
            }

            const barHeight = Math.max(2, maxPeak * height * 0.85);
            const x = i * (barWidth + gap);
            const y = centerY - barHeight / 2;
            const radius = Math.min(barWidth / 2, barHeight / 2);

            ctx.beginPath();
            if (typeof ctx.roundRect === 'function') {
                ctx.roundRect(x, y, barWidth, barHeight, radius);
            } else {
                ctx.rect(x, y, barWidth, barHeight);
            }
            ctx.fill();
        }
    }
}

export const waveformGenerator = new WaveformGenerator();
