async function testSend() {
  const recipient = '201144716359';
  const testPdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<\n/Type /Catalog\n>>\nendobj\ntrailer\n<<\n/Root 1 0 R\n>>\n%%EOF');
  
  const payload = {
    number: recipient,
    mediatype: 'document',
    mimetype: 'application/pdf',
    caption: 'Test report',
    media: testPdf.toString('base64'), // Raw base64 WITHOUT data:... prefix
    fileName: 'test.pdf',
  };

  const url = `${process.env.EVOLUTION_API_URL}/message/sendMedia/${process.env.EVOLUTION_INSTANCE_NAME}`;
  console.log('Calling:', url);
  
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: process.env.EVOLUTION_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  console.log('STATUS:', res.status, res.statusText);
  const text = await res.text();
  console.log('RESPONSE BODY:', text);
}

testSend().catch(console.error);
