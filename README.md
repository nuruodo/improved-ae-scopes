# Improved AE Scopes

A colour scopes panel for After Effects: waveform, RGB / YCbCr parade, vectorscope, histogram, CIE xy chromaticity
and an exposure-aid image view, with a readout bar underneath. Lumetri Scopes, but better.

## Install

1. Download `improved-ae-scopes-v1.0.0.zip` from the [latest release](https://github.com/nuruodo/improved-ae-scopes/releases/latest) and unzip it.
2. Unsigned CEP panels need **PlayerDebugMode** turned on once. In a terminal, run:
   ```
   reg add HKCU\Software\Adobe\CSXS.11 /v PlayerDebugMode /t REG_SZ /d 1 /f
   reg add HKCU\Software\Adobe\CSXS.12 /v PlayerDebugMode /t REG_SZ /d 1 /f
   ```
3. Right-click `install.ps1` > **Run with PowerShell** (per-user, no admin needed).
4. Restart After Effects, then open **Window > Extensions > Scopes**.

To uninstall, run `.\install.ps1 -Uninstall`.

## Live updates

Open the panel and leave it. It follows After Effects on its own: the active comp, the current time (scrubbing and
playback), every edit, and the project's colour settings. You don't need to click anything or grab a frame.
*Update: Live* captures continuously and *Manual* freezes the scopes.

The capture follows the viewer's *Resolution* (Full / Half / Third...), so a lower setting updates faster.

## Colour management

* Reads full 16-bit precision, including 32 bpc HDR values up to 10.0.
* **Adobe colour management**: every working profile After Effects lists (sRGB, Rec.709, Rec.2020 PQ/HLG, P3,
  Adobe RGB, ProPhoto, ACEScg, ACEScct, ACES 2065-1, gamma profiles), with Linearize Working Space on or off.
* **OCIO**: ACES configs, with a choice of sRGB, ACES SDR or raw view.
* **Scope colour space**: Rec.709 / Rec.2020 / Rec.601, with sRGB, γ2.4, γ2.2 or BT.709 display transfer.
* Gamut conversion from the working space to the display, so wide-gamut projects show correct colours.
* **HDR**: values over 100% are kept. The waveform and histogram extend automatically, and the info bar shows stops
  above white.
* A badge under the top bar says what the pipeline assumes, e.g.
  `32 bpc · ACEScg (linearized) · linear-light · as seen in Rec.709 (sRGB)`. Click it to change the settings.

## Tools

* **Waveform**: Luma · RGB overlay · RGB parade · YCbCr parade; graticule in %, 8-bit, 10-bit or float.
* **Vectorscope**: 100% / 75% targets, skin-tone line, 1–4× zoom.
* **Histogram**: R G B + luma, log scale, clip markers, over-range counter.
* **CIE 1931 xy**: the working gamut, with Rec.709 / P3 / Rec.2020 for reference.
* **Image**: False Color, Zebra and Clipping overlays.
* **Zoom and pan** on every scope: scroll to zoom, drag to pan, double-click to reset. Zoomed scopes are
  re-analysed for real detail, not stretched pixels.
* **Region of interest**: drag a box on the image and every scope analyses only that region.
* **Hover readouts** on every scope.
* **Information bar**: RGB + hex, Y, HSL, Lab, xy, luma min/median/max, clipping %, saturation and a 5-colour
  palette (click a chip to copy its hex).
* **Layout**: 1, 2 or 4 scopes depending on panel size, or a fixed layout. Settings persist.
