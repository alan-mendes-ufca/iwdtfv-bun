import json,subprocess,pathlib,time,os
root=pathlib.Path(os.environ['BENCH_ROOT']).expanduser().resolve()
app=json.loads(subprocess.check_output(['docker','inspect','iwdtfv-personal-app-1']))[0]
network=next(iter(app['NetworkSettings']['Networks']))
image=app['Config']['Image']
secret=next(m['Source'] for m in app['Mounts'] if m['Destination']=='/run/secrets/youtube_cookies')
variants=['baseline','auth-hint','metadata-cache','combined','fragments-2','fragments-4']
output=root/'results.jsonl'
with output.open('w') as file:
 for rep in range(1,4):
  order=variants[rep-1:]+variants[:rep-1]
  for variant in order:
   source='fragments' if variant.startswith('fragments-') else variant
   name=f'iwdtfv-perf-{variant}-{rep}'
   cmd=['docker','run','--rm','--name',name,'--network',network,'--read-only','--init','--no-healthcheck','--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','128','--tmpfs','/tmp:rw,exec,nosuid,nodev,size=2147483648,uid=1000,gid=1000,mode=1777','--entrypoint','bun']
   for directory in ['infra','models','pages']:
    cmd+=['--mount',f'type=bind,src={root/source/directory},dst=/app/{directory},readonly']
   cmd+=['--mount',f'type=bind,src={root/"bench.ts"},dst=/app/bench.ts,readonly','--mount',f'type=bind,src={secret},dst=/run/secrets/youtube_cookies,readonly']
   env={'YTDLP_COOKIES_MODE':'fallback','YTDLP_COOKIES_FILE':'/run/secrets/youtube_cookies','YTDLP_PROXY':'http://egress:3128','MIN_FREE_BYTES':'1','MAX_FILESIZE_BYTES':'268435456','MAX_CONCURRENT_DOWNLOADS':'1','BENCH_VARIANT':variant,'BENCH_REP':str(rep),'PERFORMANCE_AUTH_HINT':'1' if variant in ['auth-hint','combined'] else '0','PERFORMANCE_METADATA_CACHE':'1' if variant in ['metadata-cache','combined'] else '0','YTDLP_FRAGMENT_CONCURRENCY':variant.split('-')[-1] if variant.startswith('fragments-') else '1'}
   for key,value in env.items():cmd+=['-e',key+'='+value]
   cmd+=[image,'run','/app/bench.ts']
   try:
    r=subprocess.run(cmd,capture_output=True,text=True,timeout=180)
    lines=[line for line in r.stdout.splitlines() if line.startswith('{')]
    result=json.loads(lines[-1]) if lines else {'variant':variant,'rep':rep,'error':'NoBenchmarkResult','exit':r.returncode}
   except subprocess.TimeoutExpired:
    subprocess.run(['docker','rm','-f',name],capture_output=True)
    result={'variant':variant,'rep':rep,'error':'BenchmarkTimeout'}
   line=json.dumps(result);print(line,flush=True);file.write(line+'\n');file.flush()
