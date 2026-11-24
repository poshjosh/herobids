You are running a document-messaging test of your own messaging tools. Work autonomously. Ask me nothing unless a prerequisite is missing.

Test document: the PDF I sent in this chat (the latest "User sent document" message).

Keep a ledger with set_memory under key doc_test_results: one line per check with PASS or FAIL and the evidence. Sends are asynchronous, so after each send end your turn and wait; on each wake, read the ledger and continue with the next pending check. Do not poll.

Setup
1. If create_child_agent is not available, or your child allowance is 0, record FAIL: no child allowance, and stop.
2. Call list_agent_documents. Note the documentId of the test PDF.
3. Create two children with create_child_agent, start true:
   - name "doc-test-alpha", prompt: ALPHA_PROMPT
   - name "doc-test-beta", prompt: BETA_PROMPT
   ALPHA_PROMPT: "You are doc-test-alpha, a document test agent. When a message with an attached document arrives, call list_agent_documents, then read_agent_document on that document. Reply to the sender with the filename and the first line of the text, or the exact error. When your creator asks you to send a document to doc-test-beta, call message_peer_agent to doc-test-beta with the document id in documentIds, then send_message to your creator with beta's reply, or the exact error. Do nothing else."
   BETA_PROMPT: "You are doc-test-beta, a document test agent. When a message with an attached document arrives from doc-test-alpha, call list_agent_documents, then read_agent_document on that document. Reply to doc-test-alpha with the filename and the first line of the text, or the exact error. Do nothing else."

Checks (run in order, one at a time)

A. parent <-> child, message_child_agent with document: message_child_agent to doc-test-alpha, body "Test A: read the attached document", documentIds [PDF id]. PASS when alpha's reply names the PDF and gives its first line.

B. child -> parent, send_message with document: message_child_agent to doc-test-alpha, body "Test B: send your copy of the test PDF to me with send_message. Use the documentId of your own copy, from your document notice or list_agent_documents. If send_message fails, message me with no documentIds and the exact error." Do not put any documentId in this message yourself. PASS when alpha's send_message returns success and its report reaches you. FAIL with alpha's exact error if it reports a failure.

C. parent -> child, message_peer_agent with document: message_peer_agent to doc-test-alpha, body "Test C: read the attached document and reply", documentIds [PDF id]. PASS when alpha's reply names the PDF and gives its first line.

D. peer <-> peer, message_peer_agent with document: message_peer_agent to doc-test-alpha, body "Test D: send the test PDF to doc-test-beta with message_peer_agent, then tell me beta's reply". PASS when alpha reports beta's reply naming the PDF and its first line.

E. limit: message_peer_agent to doc-test-alpha with four documentIds (the PDF plus three made-up ids). PASS when the call is refused with a validation error and nothing is sent.

Final report, after all checks have a result:

parent <-> child
- send_message with document -> PASS/FAIL, evidence
- message_peer_agent with document -> PASS/FAIL, evidence
- message_child_agent with document -> PASS/FAIL, evidence

peer <-> peer
- message_peer_agent with document -> PASS/FAIL, evidence
limit
- four documentIds refused -> PASS/FAIL, exact error

Do not retry a failed check. Record the exact error and continue.