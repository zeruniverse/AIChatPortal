# v7.0.2 native-server audit note

This package is based on v7.0.1 native-server deployment.

Changes:
- Attachment transport/extraction details were removed from the user/follow-up prompt.
- Those details now exist only in the backend `system` message when an attachment image is sent.
- Attachment archives and the multi-turn context archive use tar.xz with xz level 8.
- The system message was updated for the tar.xz attachment format and still requires the model to reference only original uploaded filenames.
- If an attachment cannot be read, the model is told to state that briefly without revealing the transport mechanism.
- Images pasted into the initial-question or follow-up textarea are uploaded as attachments.
- Completed answers show elapsed minutes in the private conversation detail page.
- Compressed attachment packages are limited to 78,000,000 bytes, the multi-turn context package uses the same limit, and each turn's raw uploads must remain below 1,000,000,000 bytes.
