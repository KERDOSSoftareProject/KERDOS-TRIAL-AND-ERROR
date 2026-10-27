/** Complete a newly stored message without letting an attachment failure
 * suppress its optional forwarding attempt. Forwarding is best-effort, but
 * its attempt is awaited before the webhook acknowledges the new message.
 */
export async function finishFreshMessage(processAttachments, forwardEmail = null, onForwardError = () => {}) {
  let processingError;
  try {
    await processAttachments();
  } catch (error) {
    processingError = error;
  }
  if (forwardEmail) {
    try {
      await forwardEmail();
    } catch (error) {
      onForwardError(error);
    }
  }
  if (processingError) throw processingError;
}
