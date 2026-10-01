#!/usr/bin/env node
import { launch } from '../src/bootstrap.js';
process.exitCode = await launch();
