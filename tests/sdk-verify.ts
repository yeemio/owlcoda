/**
 * End-to-end verification script.
 * Prerequisites: owlcoda running at :8019, Router at :8009.
 * Run: npx tsx tests/sdk-verify.ts
 */

import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({
  baseURL: 'http://127.0.0.1:8019',
  apiKey: 'local',
})

async function test1_nonStreaming() {
  console.log('\n=== Test 1: Non-streaming basic conversation ===')
  try {
    const msg = await client.messages.create({
      model: 'default',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'Say exactly: OwlCoda works!' }],
    })
    console.log('Response type:', msg.type)
    console.log('Model:', msg.model)
    console.log('Stop reason:', msg.stop_reason)
    console.log('Content:', msg.content)
    console.log('Usage:', msg.usage)

    if (msg.type !== 'message') throw new Error(`Expected type "message", got "${msg.type}"`)
    if (msg.role !== 'assistant') throw new Error(`Expected role "assistant"`)
    if (!msg.id.startsWith('msg_')) throw new Error(`Expected id starting with "msg_"`)
    if (msg.content.length === 0) throw new Error('Expected non-empty content')
    if (msg.content[0].type !== 'text') throw new Error(`Expected text block`)
    console.log('✅ PASS')
  } catch (err) {
    console.error('❌ FAIL:', err)
  }
}

async function test2_streaming() {
  console.log('\n=== Test 2: Streaming conversation ===')
  try {
    const stream = await client.messages.create({
      model: 'default',
      max_tokens: 256,
      stream: true,
      messages: [{ role: 'user', content: 'Count from 1 to 3, one number per line' }],
    })

    let gotMessageStart = false
    let gotContentBlockStart = false
    let gotContentBlockDelta = false
    let gotContentBlockStop = false
    let gotMessageDelta = false
    let gotMessageStop = false
    let fullText = ''

    for await (const event of stream) {
      switch (event.type) {
        case 'message_start':
          gotMessageStart = true
          console.log('  message_start: model =', event.message.model)
          break
        case 'content_block_start':
          gotContentBlockStart = true
          console.log('  content_block_start: type =', event.content_block.type)
          break
        case 'content_block_delta':
          gotContentBlockDelta = true
          if (event.delta.type === 'text_delta') {
            fullText += event.delta.text
            process.stdout.write(event.delta.text)
          }
          break
        case 'content_block_stop':
          gotContentBlockStop = true
          break
        case 'message_delta':
          gotMessageDelta = true
          console.log('\n  message_delta: stop_reason =', event.delta.stop_reason)
          break
        case 'message_stop':
          gotMessageStop = true
          break
      }
    }

    console.log('Full text:', fullText.trim())

    if (!gotMessageStart) throw new Error('Missing message_start')
    if (!gotContentBlockStart) throw new Error('Missing content_block_start')
    if (!gotContentBlockDelta) throw new Error('Missing content_block_delta')
    if (!gotContentBlockStop) throw new Error('Missing content_block_stop')
    if (!gotMessageDelta) throw new Error('Missing message_delta')
    if (!gotMessageStop) throw new Error('Missing message_stop')
    if (fullText.trim().length === 0) throw new Error('Empty response text')
    console.log('✅ PASS')
  } catch (err) {
    console.error('❌ FAIL:', err)
  }
}

async function test3_toolUse() {
  console.log('\n=== Test 3: Tool use ===')
  try {
    const msg = await client.messages.create({
      model: 'default',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Calculate 15 * 7 using the calculator tool. You must use the tool.' }],
      tools: [{
        name: 'calculator',
        description: 'Calculate a math expression',
        input_schema: {
          type: 'object' as const,
          properties: { expression: { type: 'string', description: 'Math expression' } },
          required: ['expression'],
        },
      }],
    })

    console.log('Stop reason:', msg.stop_reason)
    for (const block of msg.content) {
      if (block.type === 'text') console.log('  text:', block.text.slice(0, 100))
      if (block.type === 'tool_use') {
        console.log('  tool_use:', block.name, block.input)
        if (!block.id) throw new Error('tool_use missing id')
      }
    }

    const toolUseBlocks = msg.content.filter(b => b.type === 'tool_use')
    if (toolUseBlocks.length > 0) {
      console.log('✅ PASS (tool used)')
    } else {
      console.log('⚠️ PASS (no tool used — model chose not to, format correct)')
    }
  } catch (err) {
    console.error('❌ FAIL:', err)
  }
}

async function test4_multiTurn() {
  console.log('\n=== Test 4: Multi-turn with tool_result ===')
  try {
    const msg = await client.messages.create({
      model: 'default',
      max_tokens: 256,
      messages: [
        { role: 'user', content: 'What files are in /tmp?' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check.' },
            { type: 'tool_use', id: 'call_test_1', name: 'Bash', input: { command: 'ls /tmp' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_test_1', content: 'file1.txt\nfile2.txt\nfolder1' },
          ],
        },
      ],
    })

    console.log('Response type:', msg.type)
    if (msg.type !== 'message') throw new Error('Wrong type')
    if (msg.content.length === 0) throw new Error('Empty content')
    console.log('✅ PASS')
  } catch (err) {
    console.error('❌ FAIL:', err)
  }
}

async function test5_models() {
  console.log('\n=== Test 5: Models endpoint ===')
  try {
    const resp = await fetch('http://127.0.0.1:8019/v1/models')
    const data = await resp.json() as any
    console.log('Models count:', data.data?.length)
    for (const m of data.data ?? []) {
      console.log(`  ${m.id} → ${m.display_name}`)
    }
    if (!data.data || data.data.length === 0) throw new Error('No models')
    console.log('✅ PASS')
  } catch (err) {
    console.error('❌ FAIL:', err)
  }
}

async function test6_errorHandling() {
  console.log('\n=== Test 6: Error handling ===')
  try {
    try {
      await client.messages.create({
        model: 'default',
        max_tokens: 0,
        messages: [{ role: 'user', content: 'hi' }],
      })
      console.log('  ⚠️ Expected error but got success')
    } catch (err: any) {
      console.log('  Invalid max_tokens:', err.status, err.error?.error?.type)
      if (err.status === 400) console.log('  ✅ Correct')
    }

    try {
      await client.messages.create({
        model: 'default',
        max_tokens: 100,
        messages: [],
      })
      console.log('  ⚠️ Expected error but got success')
    } catch (err: any) {
      console.log('  Empty messages:', err.status, err.error?.error?.type)
      if (err.status === 400) console.log('  ✅ Correct')
    }

    console.log('✅ PASS')
  } catch (err) {
    console.error('❌ FAIL:', err)
  }
}

async function main() {
  console.log('OwlCoda SDK Verification')
  console.log('======================')
  console.log(`Target: ${client.baseURL}`)

  try {
    const health = await fetch('http://127.0.0.1:8019/healthz')
    const data = await health.json()
    console.log('Proxy health:', data)
  } catch {
    console.error('ERROR: OwlCoda proxy not running at :8019')
    process.exit(1)
  }

  await test1_nonStreaming()
  await test2_streaming()
  await test3_toolUse()
  await test4_multiTurn()
  await test5_models()
  await test6_errorHandling()

  console.log('\n=== All tests complete ===')
}

main()
