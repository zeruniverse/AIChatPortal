import http from 'node:http';
import fs from 'node:fs';
const out = process.env.MOCK_LOG;
let count = 0;
const server = http.createServer(async (req,res) => {
  const chunks=[];
  for await (const c of req) chunks.push(c);
  const raw=Buffer.concat(chunks).toString('utf8');
  let body;
  try { body=JSON.parse(raw); } catch (e) { res.writeHead(400); return res.end('bad json'); }
  count++;
  const imageUrl = body.messages?.flatMap(m => Array.isArray(m.content) ? m.content : []).find(x => x?.type==='image_url')?.image_url?.url || null;
  const record={count,model:body.model,prompt:body.messages?.at(-1)?.content?.[0]?.text || body.messages?.at(-1)?.content,imageUrl};
  fs.appendFileSync(out, JSON.stringify(record)+'\n');
  if (String(record.prompt).includes('credit-error')) {
    res.writeHead(402, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({error:{message:'insufficient credit',type:'payment_required',code:'insufficient_credit'}}));
  }
  if (String(record.prompt).includes('stream-image-response')) {
    res.writeHead(200, {'Content-Type':'text/event-stream'});
    res.write(`data: ${JSON.stringify({choices:[{delta:{content:'stream image',images:[{url:'https://files.example.test/stream.png'}]}}]})}\n\n`);
    return res.end('data: [DONE]\n\n');
  }
  if (String(record.prompt).includes('image-response')) {
    res.writeHead(200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({choices:[{message:{content:[{type:'text',text:'image follows'},{type:'image_url',image_url:{url:'https://files.example.test/result.png'}}]}}]}));
  }
  res.writeHead(200, {'Content-Type':'text/event-stream'});
  const content = `<think>thought-${count}</think>## 回答： response-${count}<think>more-${count}</think>tail-${count}`;
  res.write(`data: ${JSON.stringify({choices:[{delta:{content:content.slice(0, Math.ceil(content.length/2))}}]})}\r\n\r\n`);
  setTimeout(() => {
    res.write(`data: ${JSON.stringify({choices:[{delta:{content:content.slice(Math.ceil(content.length/2))}}]})}\r\n\r\n`);
    res.end('data: [DONE]\r\n\r\n');
  }, 30);
});
server.listen(Number(process.env.MOCK_PORT || 4101), '127.0.0.1');
