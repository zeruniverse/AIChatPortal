# v7.0.2 native-server audit note

This package is based on v7.0.1 native-server deployment and changes only model-prompt handling plus version/documentation metadata.

Changes:
- Attachment transport/extraction details were removed from the user/follow-up prompt.
- Those details now exist only in the backend `system` message when an attachment image is sent.
- The system message instructs the model not to disclose JPEG/ZIP/EOI/cat/att.zip/numbered-turn-zip implementation details.
- The system message instructs the model to reference only original uploaded filenames.
- If an attachment cannot be read, the model is told to state that briefly without revealing the transport mechanism.
- Frontend behavior, APIs, storage format, authentication, sharing, cleanup, and native server deployment are unchanged.
