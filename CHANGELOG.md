# Changelog

All notable changes to this project are documented here.

## [1.0.0] - 2026-06-01

- Added playlist input from text files, M3U/M3U8 files, Qobuz URLs, and Spotify playlist URLs.
- Added Qobuz search and fuzzy match scoring with automatic and interactive selection modes.
- Added sequential downloads with optional WAV conversion through `ffmpeg`.
- Added automatic captcha cookie capture through a temporary Chrome profile.
- Added resume support by skipping existing output files.
- Added match caching for faster restarts after interrupted runs.
- Added macOS Terminal.app relaunch support with `--via-terminal`.
