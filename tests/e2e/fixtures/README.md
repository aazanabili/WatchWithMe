# Runtime media fixtures

The media QA suite generates its tiny MP4, MPEG-TS, and (when available) WebM
fixtures with the `ffmpeg` installed in the `media-worker` container, then
copies them out with `docker cp`. No fake media bytes or contract-only uploads
are used. If WebM cannot be encoded, the run records the exact ffmpeg error in
the temporary `webm-unavailable.txt` artifact and reports WebM as unavailable.
