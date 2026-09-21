#!/usr/bin/env node
'use strict'

/**
 * Quick test for FreeLLM API compatibility
 * Run: node test-ai-chat.js
 */

const axios = require('axios')

// Test configuration - edit these
const API_KEY = process.env.FREE_LLM_API_KEY || 'test-key'
const BASE_URL = process.env.FREE_LLM_BASE_URL || 'http://onlyaprogram.northcentralus.cloudapp.azure.com:3001/v1'

const client = axios.create({
  baseURL: BASE_URL,
  headers: {
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Type': 'application/json'
  },
  timeout: 10000
})

async function testEndpoint() {
  console.log('Testing FreeLLM API at:', BASE_URL)
  console.log('API Key length:', API_KEY.length, '(hidden)')
  console.log('')

  // Test 1: Chat completions
  console.log('Test 1: /chat/completions endpoint')
  try {
    const response = await client.post('/chat/completions', {
      model: 'auto:fast',
      messages: [
        {
          role: 'system',
          content: 'You are a Minecraft player. Respond in 15 words or less.'
        },
        {
          role: 'user',
          content: 'Hello!'
        }
      ],
      max_tokens: 100,
      temperature: 0.8
    })
    console.log('✓ SUCCESS - Response:', response.data?.choices?.[0]?.message?.content?.trim() || 'no content')
  } catch (error) {
    console.log('✗ FAILED:', error.message)
    if (error.response) {
      console.log('  Status:', error.response.status)
      console.log('  Data:', error.response.data)
    }
  }
  console.log('')

  // Test 2: Responses endpoint (Anthropic-compatible)
  console.log('Test 2: /responses endpoint')
  try {
    const response = await client.post('/responses', {
      model: 'auto:fast',
      messages: [
        {
          role: 'system',
          content: 'You are a Minecraft player. Respond in 15 words or less.'
        },
        {
          role: 'user',
          content: 'Hello!'
        }
      ],
      max_tokens: 100,
      temperature: 0.8
    })
    console.log('✓ SUCCESS - Response:', response.data?.outputs?.[0]?.text || 'no content')
  } catch (error) {
    console.log('✗ FAILED:', error.message)
    if (error.response) {
      console.log('  Status:', error.response.status)
      console.log('  Data:', error.response.data)
    }
  }
  console.log('')

  // Test 3: Without model field
  console.log('Test 3: /chat/completions without model field')
  try {
    const response = await client.post('/chat/completions', {
      messages: [
        {
          role: 'system',
          content: 'You are a Minecraft player. Respond in 15 words or less.'
        },
        {
          role: 'user',
          content: 'Hello!'
        }
      ],
      max_tokens: 100,
      temperature: 0.8
    })
    console.log('✓ SUCCESS - Response:', response.data?.choices?.[0]?.message?.content?.trim() || 'no content')
  } catch (error) {
    console.log('✗ FAILED:', error.message)
    if (error.response) {
      console.log('  Status:', error.response.status)
      console.log('  Data:', error.response.data)
    }
  }
}

testEndpoint().catch(err => {
  console.error('Test failed:', err)
  process.exit(1)
})
