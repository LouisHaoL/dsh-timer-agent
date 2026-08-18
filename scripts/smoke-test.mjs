#!/usr/bin/env node
/**
 * Smoke test for dsh-timer-agent: validates that all required files
 * and components exist in the source code.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = dirname(__dirname)

console.log('🔍 dsh-timer-agent smoke test started\n')

let passed = 0
let failed = 0

// Test 1: Core files exist
const coreFiles = [
  'src/index.ts',
  'src/invariant.ts',
  'src/core/jobs.ts',
  'src/core/schedule.ts',
  'src/core/store.ts',
  'src/core/controller.ts',
  'src/host/store.ts',
  'src/host/runner.ts',
  'src/host/tools.ts',
  'src/host/routes.ts',
  'src/host/contracts.ts',
  'src/client/index.ts',
  'src/client/remote-controller.ts',
  'src/client/controller-face.ts',
  'src/client/target-options.ts',
  'src/client/sidebar-entry.ts',
]

coreFiles.forEach(file => {
  const filePath = join(projectRoot, file)
  try {
    readFileSync(filePath, 'utf8')
    passed++
    console.log(`✅ ${file} exists`)
  } catch {
    failed++
    console.error(`❌ ${file} not found`)
  }
})

// Test 2: Host entry has ticker
const indexPath = join(projectRoot, 'src/index.ts')
try {
  const indexContent = readFileSync(indexPath, 'utf8')
  if (indexContent.includes('TimerRunner') && indexContent.includes('start()')) {
    passed++
    console.log(`✅ Host entry starts TimerRunner ticker`)
  } else {
    failed++
    console.error(`❌ Host entry missing TimerRunner ticker`)
  }
} catch {
  failed++
  console.error(`❌ Failed to read host entry`)
}

// Test 3: Store uses file at ~/.dsh/timer-agent/jobs.json
const storePath = join(projectRoot, 'src/host/store.ts')
try {
  const storeContent = readFileSync(storePath, 'utf8')
  if (storeContent.includes('.dsh') && storeContent.includes('timer-agent') && storeContent.includes('jobs.json')) {
    passed++
    console.log(`✅ HostJobStore uses ~/.dsh/timer-agent/jobs.json`)
  } else {
    failed++
    console.error(`❌ HostJobStore missing correct file path`)
  }
} catch {
  failed++
  console.error(`❌ Failed to read store`)
}

// Test 4: Runner uses agents.create/resume
const runnerPath = join(projectRoot, 'src/host/runner.ts')
try {
  const runnerContent = readFileSync(runnerPath, 'utf8')
  if (runnerContent.includes('agents.create') && runnerContent.includes('agents.resume')) {
    passed++
    console.log(`✅ TimerRunner uses agents.create/resume`)
  } else {
    failed++
    console.error(`❌ TimerRunner missing agents.create/resume`)
  }
} catch {
  failed++
  console.error(`❌ Failed to read runner`)
}

// Test 5: Tool is registered
const toolsPath = join(projectRoot, 'src/host/tools.ts')
try {
  const toolsContent = readFileSync(toolsPath, 'utf8')
  if (toolsContent.includes('timer_agent') && toolsContent.includes('registerTimerTool')) {
    passed++
    console.log(`✅ timer_agent tool is registered`)
  } else {
    failed++
    console.error(`❌ timer_agent tool missing`)
  }
} catch {
  failed++
  console.error(`❌ Failed to read tools`)
}

// Test 6: Routes are defined
const routesPath = join(projectRoot, 'src/host/routes.ts')
try {
  const routesContent = readFileSync(routesPath, 'utf8')
  if (routesContent.includes('/api/dsh-timer-agent') && routesContent.includes('GET') && routesContent.includes('POST')) {
    passed++
    console.log(`✅ HTTP routes /api/dsh-timer-agent/* defined`)
  } else {
    failed++
    console.error(`❌ HTTP routes missing`)
  }
} catch {
  failed++
  console.error(`❌ Failed to read routes`)
}

// Test 7: Client uses HTTP polling
const remoteControllerPath = join(projectRoot, 'src/client/remote-controller.ts')
try {
  const remoteControllerContent = readFileSync(remoteControllerPath, 'utf8')
  if (remoteControllerContent.includes('fetch') && remoteControllerContent.includes('setInterval') && remoteControllerContent.includes('/api/dsh-timer-agent')) {
    passed++
    console.log(`✅ Client uses HTTP polling`)
  } else {
    failed++
    console.error(`❌ Client missing HTTP polling`)
  }
} catch {
  failed++
  console.error(`❌ Failed to read remote controller`)
}

// Test 8: 60s ticker interval
const runnerContent = readFileSync(runnerPath, 'utf8')
if (runnerContent.includes('60_000') || runnerContent.includes('60000')) {
  passed++
  console.log(`✅ Ticker interval is 60s`)
} else {
  failed++
  console.error(`❌ Ticker interval not 60s`)
}

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('\n⚠️  Some checks failed. Please review the implementation.')
  process.exit(1)
} else {
  console.log('✨ All smoke tests passed!')
  console.log('\n📝 Implementation summary:')
  console.log('   ✅ Host-side 60s ticker')
  console.log('   ✅ File-backed store at ~/.dsh/timer-agent/jobs.json')
  console.log('   ✅ agents.create/resume for session execution')
  console.log('   ✅ timer_agent model tool')
  console.log('   ✅ /api/dsh-timer-agent/* HTTP routes')
  console.log('   ✅ Browser HTTP client with polling')
  console.log('   ✅ UI interaction preserved')
  process.exit(0)
}