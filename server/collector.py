"""Read-only GDB collector. All values originate from the stopped inferior.
No function calls or assignment expressions are accepted from the UI.
"""
import gdb, json, base64, time, struct, re, os, ast, operator

CACHE = {}
SCALARS = {}
GENERATION = 0
INVALID_PATHS = set()
BUDGET = 8 * 1024 * 1024
FORMATS = {1: ('b','B'), 2: ('h','H'), 4: ('i','I'), 8: ('q','Q')}

def merge_ranges(ranges):
    result=[]
    for a,b in sorted(ranges):
        if result and a<=result[-1][1]+1:result[-1]=(result[-1][0],max(result[-1][1],b))
        else:result.append((a,b))
    return result

def typename(t):
    return str(t.strip_typedefs())

def plain(v):
    t = v.type.strip_typedefs()
    if t.code == gdb.TYPE_CODE_BOOL: return 'true' if int(v) else 'false'
    if t.code in (gdb.TYPE_CODE_INT, gdb.TYPE_CODE_ENUM): return str(int(v))
    if t.code == gdb.TYPE_CODE_FLT: return str(float(v))
    return str(v)

def resolve(path):
    if any(path==p or path.startswith(p+'[') or path.startswith(p+'.') for p in INVALID_PATHS):
        raise ValueError('退出时对象可能已析构，不能读取有效内容')
    # Resolve names, members and constant indices without inferior evaluation.
    if not re.fullmatch(r'[A-Za-z_]\w*(?:(?:\.[A-Za-z_]\w*)|(?:\[\d+\]))*', path):
        raise ValueError('只允许变量、字段和常量下标')
    root = re.match(r'[A-Za-z_]\w*', path).group()
    symbol, _ = gdb.lookup_symbol(root)
    if symbol is None or not (symbol.is_variable or symbol.is_argument):
        raise ValueError('变量不可用: ' + root)
    value = symbol.value(gdb.selected_frame())
    for match in re.finditer(r'\.([A-Za-z_]\w*)|\[(\d+)\]', path[len(root):]):
        if match.group(1): value = value[match.group(1)]
        else:
            idx = int(match.group(2))
            t = value.type.strip_typedefs()
            if t.code == gdb.TYPE_CODE_ARRAY:
                lo, hi = t.range()
                if not lo <= idx <= hi: raise ValueError('数组下标越界')
                value = value[idx]
            elif typename(t).startswith('std::vector<') and 'vector<bool' not in typename(t):
                start, finish = value['_M_impl']['_M_start'], value['_M_impl']['_M_finish']
                if not 0 <= idx < int(finish-start): raise ValueError('vector 下标越界')
                value = (start+idx).dereference()
            else: raise ValueError('下标仅支持数组和数值 vector')
    return value

def evaluate(expression):
    # Python AST used only as a bounded pure-expression grammar, never eval().
    if len(expression) > 256: raise ValueError('表达式过长')
    ops = {ast.Add:operator.add,ast.Sub:operator.sub,ast.Mult:operator.mul,ast.FloorDiv:operator.floordiv,ast.Mod:operator.mod}
    tree = ast.parse(expression, mode='eval')
    if sum(1 for _ in ast.walk(tree)) > 64: raise ValueError('表达式过于复杂')
    def visit(node):
        if isinstance(node, ast.Constant) and type(node.value) in (int,float,bool): return node.value
        if isinstance(node, (ast.Name, ast.Attribute, ast.Subscript)): return resolve(ast.unparse(node).replace(' ',''))
        if isinstance(node, ast.UnaryOp) and isinstance(node.op,(ast.USub,ast.UAdd)):
            return (-1 if isinstance(node.op,ast.USub) else 1)*int(visit(node.operand))
        if isinstance(node, ast.BinOp) and type(node.op) in ops:
            result = ops[type(node.op)](int(visit(node.left)),int(visit(node.right)))
            if abs(result) > 2**128: raise ValueError('计算结果过大')
            return result
        raise ValueError('不支持此表达式；禁止函数调用与赋值')
    value=visit(tree.body)
    return plain(value) if isinstance(value,gdb.Value) else str(value)

def parse_pins(pins, expr, shape):
    ranges=[]
    for pin in pins:
        if len(shape)==2:
            matrix=re.fullmatch(re.escape(expr)+r'\[(\d+)\]\[(\d+)\]',pin)
            if matrix:
                row,col=int(matrix.group(1)),int(matrix.group(2))
                if 0<=row<shape[0] and 0<=col<shape[1]:ranges.append((row*shape[1]+col,row*shape[1]+col))
                continue
        m=re.fullmatch(re.escape(expr)+r'\[(\d+)(?:\.\.(\d+))?\]', pin)
        if m:
            start=int(m.group(1));end=int(m.group(2) or start)
            if start<=end: ranges.append((start,min(end,start+2047)))
    return ranges

def changed_at_least(old, raw, size, total, limit):
    # Count differing elements block by block and stop early; cheap even for multi-megabyte arrays.
    found=0; block=max(size,4096//size*size)
    for off in range(0,total,block):
        if raw[off:off+block]==old[off:off+block]: continue
        for p in range(off,min(off+block,total),size):
            if raw[p:p+size]!=old[p:p+size]:
                found+=1
                if found>=limit: return True
    return False

def collect_array(value, result, opts, state, line):
    t=value.type.strip_typedefs(); shape=[]
    vector=typename(t).startswith('std::vector<')
    if vector:
        if 'vector<bool' in typename(t): raise ValueError('vector<bool> 暂无连续单元格适配')
        start=value['_M_impl']['_M_start'];end=value['_M_impl']['_M_finish']
        count=int(end-start);base=int(start);leaf=start.type.strip_typedefs().target().strip_typedefs();shape=[count]
    else:
        leaf=t
        while leaf.code==gdb.TYPE_CODE_ARRAY:
            lo,hi=leaf.range();shape.append(hi-lo+1);leaf=leaf.target().strip_typedefs()
        count=1
        for n in shape: count*=n
        base=int(value.address)
    result.update(kind='matrix' if len(shape)==2 else 'array',length=count,shape=shape,address=hex(base))
    size=int(leaf.sizeof)
    if leaf.code not in (gdb.TYPE_CODE_BOOL,gdb.TYPE_CODE_INT,gdb.TYPE_CODE_ENUM,gdb.TYPE_CODE_FLT) or size not in FORMATS:
        raise ValueError('该数组元素类型暂未适配；请展开具体字段')
    expression=result['expression']; selected=opts.get('ranges',{}).get(expression)
    lo,hi=(0,count-1) if selected is None else (max(0,int(selected[0])), min(count-1,int(selected[1])))
    if count and lo>hi:raise ValueError('监测区间不在数组有效范围内')
    length=max(0,hi-lo+1); total=length*size
    if total+state['bytes']>BUDGET:
        result.update(warning='超过 8 MiB 监测总预算，请设置监测区间。此数组尚未完整监测。',cells=[],runs=[],monitored=[0,-1])
        return
    if count<0 or count>100000000 or total<0: raise ValueError('容器长度异常')
    state['bytes']+=total
    raw=bytes(gdb.selected_inferior().read_memory(base+lo*size,total)) if total else b''
    unsigned=leaf.code==gdb.TYPE_CODE_BOOL or ('unsigned' in typename(leaf))
    fmt=('<'+('f' if size==4 else 'd')) if leaf.code==gdb.TYPE_CODE_FLT else '<'+FORMATS[size][1 if unsigned else 0]
    def val(index):
        x=struct.unpack_from(fmt,raw,(index-lo)*size)[0]
        return ('true' if x else 'false') if leaf.code==gdb.TYPE_CODE_BOOL else str(x)
    key=result['id']; prev=CACHE.get(key)
    vector_continuation=vector and prev is not None and selected is None and prev['range'][0]==lo and prev['size']==size
    if vector_continuation:
        if prev['range']!=(lo,hi):prev['runs']=None
        prev['range']=(lo,hi);prev['base']=base
        prev['active']={i for i in prev['active'] if lo<=i<=hi}
    elif prev is None or prev['range']!=(lo,hi) or prev['size']!=size or prev['base']!=base:
        prev={'raw':raw,'active':set(),'range':(lo,hi),'size':size,'base':base,'chain':[], 'runs':None,'init':[]}
    active=prev['active']; pulses=set(); inferred=[]
    old=prev['raw']; differs=old!=raw
    # Uniform bulk writes are cheap to detect without allocating a million indices.
    uniform = bool(raw) and raw == raw[:size]*length
    # Only a genuine bulk write (memset / fill / assign touching >=16 elements in one step) counts as
    # initialization. An array that merely *becomes* uniform after many small edits (e.g. visited[]
    # all true, in-degrees all 0) must keep its green history.
    bulk_init=differs and opts.get('inferInitialization',True) and length>=16 and uniform and changed_at_least(old,raw,size,total,16)
    if bulk_init:
        active.clear(); inferred=[(lo,hi)]; prev['init']=inferred; prev['chain']=[]
    elif differs:
        block=max(size,4096//size*size)
        for off in range(0,total,block):
            if raw[off:off+block]==old[off:off+block]: continue
            for p in range(off,min(off+block,total),size):
                if raw[p:p+size]!=old[p:p+size]: pulses.add(lo+p//size)
        active.update(pulses)
        if opts.get('inferInitialization',True) and len(pulses)>=16:
            ordered=sorted(pulses);begin=previous=ordered[0];pattern=val(begin)
            for idx in ordered[1:]+[hi+2]:
                same=idx<=hi and idx==previous+1 and val(idx)==pattern
                if not same:
                    if previous-begin+1>=16:
                        inferred.append((begin,previous));active.difference_update(range(begin,previous+1));pulses.difference_update(range(begin,previous+1))
                    begin=idx
                    if idx<=hi:pattern=val(idx)
                previous=idx
            if inferred:prev['init']=merge_ranges(prev['init']+inferred)
        # 不再根据“连续多步写入同一个值”事后把已经变绿的格子改判为初始化：
        # 这会让用户刚看到的变化在几步后消失（例如循环里通过指针把 a[i] 逐个改成 100）。
        # 只有单步内的大批量写入（memset / fill / assign，>=16 个元素）才归为初始化。
    if opts.get('reset'):
        active.clear();pulses.clear();prev['init']=[];prev['chain']=[]
    # Cache equal-value spans; only rebuild on memory changes.
    if differs or prev['runs'] is None:
        runs=[]
        if uniform and length>=16: runs=[(lo,hi,val(lo))]
        elif length:
            start=0; pattern=raw[:size]
            for j in range(1,length+1):
                current=raw[j*size:(j+1)*size]
                if j==length or current!=pattern:
                    if j-start>=16:runs.append((lo+start,lo+j-1,val(lo+start)))
                    start=j;pattern=current
        prev['runs']=runs
    pins=parse_pins(opts.get('pins',[]),expression,shape)
    forced=set()
    for a,b in pins:forced.update(range(max(lo,a),min(hi,b)+1))
    # Graph ranges are explicitly forced, independent of automatic folding.
    for a,b in opts.get('force',{}).get(expression,[]):forced.update(range(max(lo,int(a)),min(hi,int(b))+1))
    page=max(lo,min(hi,int(opts.get('pages',{}).get(expression,lo)))) if length else lo
    if len(shape)==2 and shape[-1]:page=max(lo,(page//shape[-1])*shape[-1])
    page_count=200 if len(shape)!=2 else max(200,min(2000,shape[-1]*20))
    wanted=set(range(page,min(hi+1,page+page_count)))
    wanted.update(forced)
    # Keep off-page edits visible with a bounded change strip.
    wanted.update(sorted(pulses)[:100]);wanted.update(sorted(active)[:100])
    folded=[]; folded_intervals=[]
    # 一维数组达到 32 个元素就折叠连续 16 个以上的相同值；按网格显示的二维数组不折叠，否则行列会错位。
    if count>=32 and opts.get('fold',True) and (len(shape)!=2 or shape[-1]>200):
        for a,b,v in prev['runs']:
            exclusions=sorted(x for x in active|forced if a<=x<=b)
            start=a
            for end in exclusions+[b+1]:
                if end-start>=16:
                    init=any(s<=start<=e for s,e in prev['init'])
                    folded.append({'start':start,'end':end-1,'value':v,'reason':'疑似初始化' if init else '连续相同值'})
                    folded_intervals.append((start,end-1));wanted.update((start,end-1))
                    wanted.difference_update(range(max(start+1,page),min(end-1,page+page_count)))
                start=end+1
    def hidden(idx): return any(a<idx<b for a,b in folded_intervals) and idx not in forced and idx not in active
    cells=[{'index':i,'value':val(i),'changed':i in active,'pulse':i in pulses} for i in sorted(wanted) if lo<=i<=hi and not hidden(i)]
    result.update(cells=cells[:4096],runs=folded[:2000],monitored=[lo,hi],page=[page,min(hi,page+page_count-1)])
    if len(cells)>4096:result['warning']='显示请求超过 4096 单元格，请缩小固定区间；监测范围仍完整采集。'
    elif lo!=0 or hi!=count-1:result['warning']='仅监测指定区间；范围外未完整监测。'
    if bulk_init or inferred or prev['init']:result['initialization']='含疑似初始化的区间（批量写入相同值，未标绿）；可关闭「初始化推断」'
    prev['raw']=raw;CACHE[key]=prev

# Pointer targets: for beginners "0x7ffe..." means nothing, so describe what the pointer points at
# (e.g. "→ a[21] = -1"). Only reads addresses and the pointee; never calls inferior functions.
POINTER_CONTEXT = {}
BASIC_CODES = (gdb.TYPE_CODE_BOOL, gdb.TYPE_CODE_INT, gdb.TYPE_CODE_ENUM, gdb.TYPE_CODE_FLT)

def match_address(value, name, addr, depth=0):
    t=value.type.strip_typedefs()
    if t.code in (gdb.TYPE_CODE_REF, getattr(gdb,'TYPE_CODE_RVALUE_REF',-1)): return None
    if typename(t).startswith('std::vector<') and 'vector<bool' not in typename(t):
        start=value['_M_impl']['_M_start'];begin=int(start);end=int(value['_M_impl']['_M_finish'])
        size=int(start.type.strip_typedefs().target().sizeof) or 1
        if begin<=addr<end and (addr-begin)%size==0: return '%s[%d]'%(name,(addr-begin)//size)
        return None
    if value.address is None: return None
    base=int(value.address);total=int(t.sizeof)
    if not base<=addr<base+max(total,1): return None
    if t.code==gdb.TYPE_CODE_ARRAY:
        shape=[];leaf=t
        while leaf.code==gdb.TYPE_CODE_ARRAY:
            lo,hi=leaf.range();shape.append(hi-lo+1);leaf=leaf.target().strip_typedefs()
        size=int(leaf.sizeof) or 1
        if (addr-base)%size: return None
        flat=(addr-base)//size;index=[]
        for n in reversed(shape): index.append(flat%n);flat//=n
        return name+''.join('[%d]'%i for i in reversed(index))
    if t.code==gdb.TYPE_CODE_STRUCT and depth<2:
        for field in t.fields():
            if field.name and not field.is_base_class:
                try: found=match_address(value[field.name],name+'.'+field.name,addr,depth+1)
                except Exception: found=None
                if found: return found
        return None
    return name if base==addr else None

def pointer_target(addr):
    ctx=POINTER_CONTEXT
    for frame,label in ctx.get('frames',[]):
        try: block=frame.block()
        except Exception: continue
        while block is not None and not block.is_global and not block.is_static:
            for sym in block:
                if not (sym.is_variable or sym.is_argument) or not ctx['in_project'](sym.symtab): continue
                try: found=match_address(sym.value(frame),sym.name,addr)
                except Exception: found=None
                if found: return found if not label else '%s 的 %s'%(label,found)
            block=block.superblock
    for block in ctx.get('globals',[]):
        for sym in block:
            if not sym.is_variable or not ctx['in_project'](sym.symtab): continue
            try: found=match_address(sym.value(),sym.name,addr)
            except Exception: found=None
            if found: return found
    return None

def pointer_text(value):
    t=value.type.strip_typedefs();target=t.target().strip_typedefs()
    if target.code==gdb.TYPE_CODE_INT and int(target.sizeof)==1: return str(value) # char*: keep GDB's string view
    addr=int(value)
    if addr==0: return 'nullptr'
    name=pointer_target(addr)
    pointee=None
    if target.code in BASIC_CODES:
        try: pointee=plain(value.dereference())
        except Exception: pointee=None
    if name: return '→ %s'%name+(' = %s'%pointee if pointee is not None else '')
    return hex(addr)+(' → %s'%pointee if pointee is not None else '')

def describe(value, name, expr, key, scope, opts, state, line, depth=0):
    result={'id':key,'name':name,'expression':expr,'type':str(value.type),'scope':scope,'kind':'scalar'}
    try:
        t=value.type.strip_typedefs()
        if t.code in (gdb.TYPE_CODE_REF, getattr(gdb,'TYPE_CODE_RVALUE_REF',-1)):
            value=value.referenced_value();t=value.type.strip_typedefs()
        if value.is_optimized_out:raise ValueError('变量被优化，当前不可读')
        if t.code==gdb.TYPE_CODE_ARRAY or typename(t).startswith('std::vector<'):
            if opts.get('final') and scope!='全局' and typename(t).startswith('std::vector<'):
                INVALID_PATHS.add(expr)
                raise ValueError('退出时局部 vector 可能已析构，不能读取有效内容')
            collect_array(value,result,opts,state,line)
        elif t.code in (gdb.TYPE_CODE_STRUCT,gdb.TYPE_CODE_UNION):
            result['kind']='struct';result['children']=[]
            if depth<3 and (depth==0 or expr in opts.get('expanded',[])):
                for field in t.fields()[:64]:
                    if field.name and not field.is_base_class:
                        result['children'].append(describe(value[field.name],field.name,expr+'.'+field.name,key+'.'+field.name,scope,opts,state,line,depth+1))
        else:
            current=pointer_text(value) if t.code==gdb.TYPE_CODE_PTR else plain(value);prev=SCALARS.get(key)
            changed=prev is not None and prev[0]!=current
            ever=changed or (prev is not None and prev[1])
            if opts.get('reset'):changed=False;ever=False
            SCALARS[key]=(current,ever)
            result.update(value=current,changed=ever,pulse=changed)
        if scope!='全局':result.setdefault('warning','局部变量的初始化状态由程序决定；调试器不能始终判断。')
    except Exception as error:result.update(kind='unavailable',warning=str(error))
    return result

def graph_data(binding):
    def number(expr, default=0):return int(evaluate(expr)) if expr else default
    def scalar(expr):return evaluate(expr) if expr else ''
    def values(expr, count, base):
        if not expr:return []
        value=resolve(expr);t=value.type.strip_typedefs()
        if t.code==gdb.TYPE_CODE_ARRAY:
            lower,upper=t.range()
            if base<lower or base+count-1>upper:raise ValueError('绑定数组范围越界: '+expr)
            address=int(value.address)+base*int(t.target().sizeof);leaf=t.target().strip_typedefs()
        elif typename(t).startswith('std::vector<') and 'vector<bool' not in typename(t):
            start=value['_M_impl']['_M_start'];end=value['_M_impl']['_M_finish']
            if base<0 or base+count>int(end-start):raise ValueError('绑定 vector 范围越界: '+expr)
            leaf=start.type.strip_typedefs().target().strip_typedefs();address=int(start)+base*int(leaf.sizeof)
        else:raise ValueError('绑定要求基础类型数组或 vector: '+expr)
        size=int(leaf.sizeof)
        if leaf.code not in (gdb.TYPE_CODE_BOOL,gdb.TYPE_CODE_INT,gdb.TYPE_CODE_ENUM,gdb.TYPE_CODE_FLT) or size not in FORMATS:raise ValueError('绑定元素类型尚未支持: '+expr)
        fmt='<'+(('f' if size==4 else 'd') if leaf.code==gdb.TYPE_CODE_FLT else FORMATS[size][1 if 'unsigned' in typename(leaf) or leaf.code==gdb.TYPE_CODE_BOOL else 0])
        raw=bytes(gdb.selected_inferior().read_memory(address,count*size)) if count else b''
        return [('true' if x[0] else 'false') if leaf.code==gdb.TYPE_CODE_BOOL else str(x[0]) for x in struct.iter_unpack(fmt,raw)]
    try:
        n=number(binding.get('count',''));base=int(binding.get('base',0))
        if n<1 or n>200:raise ValueError('节点数量必须在 1—200 之间')
        m=number(binding.get('edgeCount','')) if binding['kind']=='edges' else 0
        if m<0 or m>500:raise ValueError('边数必须在 0—500 之间')
        output={'count':n,'edgeCount':m,'source':[],'from':[],'to':[],'weight':[], 'labels':[], 'status':[],'distance':[], 'current':'','target':'','root':'','absent':'','infinity':''}
        for key in ('current','target','root'):
            try:output[key]=scalar(binding.get(key,''))
            except Exception:pass # Loop variables can legitimately be out of scope.
        for key in ('absent','infinity'):output[key]=scalar(binding.get(key,''))
        for key in ('labels','status','distance'):output[key]=values(binding.get(key,''),n,base)
        if binding['kind']=='matrix':
            source=binding['source'];mat=resolve(source);t=mat.type.strip_typedefs()
            if t.code!=gdb.TYPE_CODE_ARRAY or t.target().strip_typedefs().code!=gdb.TYPE_CODE_ARRAY:raise ValueError('来源必须是二维数组')
            lower,upper=t.range()
            if base<lower or base+n-1>upper:raise ValueError('矩阵行范围越界')
            output['source']=[values(source+'['+str(i)+']',n,base) for i in range(base,base+n)]
        elif binding['kind']=='parent':output['source']=[values(binding['source'],n,base)]
        else:
            for key in ('from','to','weight'):output[key]=values(binding.get(key,''),m,0)
        return output
    except Exception as error:return {'error':str(error)}

class CppIdeSnapshot(gdb.Command):
    def __init__(self):super(CppIdeSnapshot,self).__init__('cppide-snapshot',gdb.COMMAND_DATA)
    def invoke(self,arg,from_tty):
        global GENERATION
        started=time.perf_counter()
        try:
            opts=json.loads(base64.b64decode(arg).decode('utf-8'));state={'bytes':0};frames=[];INVALID_PATHS.clear()
            root=os.path.normcase(os.path.realpath(opts['root']))
            def in_project(symtab):
                if symtab is None: return False
                try: source=os.path.normcase(os.path.realpath(symtab.fullname()))
                except Exception: return False
                return source.startswith(root+os.sep) and os.path.basename(source)!='cppide-runtime.cpp'
            def project_file(symtab):
                # Path relative to the project root (forward slashes), so the UI can open the right file.
                if not in_project(symtab): return ''
                return os.path.relpath(os.path.realpath(symtab.fullname()),os.path.realpath(opts['root'])).replace(os.sep,'/')
            f=gdb.newest_frame();level=0
            while f is not None and level<64:
                sal=f.find_sal();file=sal.symtab.filename if sal.symtab else '';line=sal.line
                try:identity=str(f.read_register('rbp'))
                except Exception:identity=str(f.read_register('sp'))
                frames.append({'level':level,'name':f.name() or '??','file':file.replace('\\','/'),'line':line,'id':(f.name() or '?')+':'+identity,'user':in_project(sal.symtab)})
                f=f.older();level+=1
            selected=min(int(opts.get('frame',0)),max(0,len(frames)-1));f=gdb.newest_frame()
            for _ in range(selected):f=f.older()
            f.select();sal=f.find_sal();location={'file':sal.symtab.filename.replace('\\','/') if sal.symtab else '', 'line':sal.line,'function':f.name() or '?','user':in_project(sal.symtab),'projectFile':project_file(sal.symtab)}
            visible_frames=[frame for frame in frames if not frame['name'].startswith('__cyg_profile_func_') and frame['name']!='cppide_final_checkpoint']
            if opts.get('probe'):
                # Location-only probe: decides auto step-out without consuming change history.
                gdb.write('CPPIDE_JSON:'+base64.b64encode(json.dumps({'location':location,'frames':visible_frames},ensure_ascii=False).encode('utf-8')).decode('ascii')+'\n')
                return
            variables=[];seen=set()
            try:block=f.block()
            except Exception:block=None
            pointer_frames=[];walker=f;steps=0
            while walker is not None and steps<64:
                try: user=in_project(walker.find_sal().symtab)
                except Exception: user=False
                if user: pointer_frames.append((walker,'' if walker==f else (walker.name() or '?')))
                walker=walker.older();steps+=1
            POINTER_CONTEXT.clear();POINTER_CONTEXT.update(frames=pointer_frames,in_project=in_project,globals=[b for b in ((block.static_block,block.global_block) if block is not None else ()) if b is not None])
            while block is not None:
                scope='全局' if block.is_global or block.is_static else '局部'
                for sym in block:
                    if not (sym.is_variable or sym.is_argument) or sym.name in seen or not sym.symtab:continue
                    source=os.path.normcase(os.path.realpath(sym.symtab.fullname()))
                    if not source.startswith(root+os.sep) and source!=root:continue
                    seen.add(sym.name)
                    identity=source+':'+str(sym.line)+':'+sym.name+(':'+frames[selected]['id'] if scope!='全局' else '')
                    if scope!='全局' and not sym.is_argument and sym.line>=sal.line and identity not in CACHE and identity not in SCALARS:
                        variables.append({'id':identity,'name':sym.name,'expression':sym.name,'type':str(sym.type),'scope':scope,'kind':'unavailable','warning':'声明语句尚未执行，初始化状态未知'})
                        continue
                    try:variables.append(describe(sym.value(f),sym.name,sym.name,identity,scope,opts,state,opts.get('executedLine',sal.line)))
                    except Exception as error:variables.append({'id':identity,'name':sym.name,'expression':sym.name,'type':str(sym.type),'scope':scope,'kind':'unavailable','warning':str(error)})
                block=block.superblock
            watches={}
            for expr in opts.get('watches',[])[:512]:
                try:watches[expr]=evaluate(expr)
                except Exception as error:watches[expr]='! '+str(error)
            GENERATION+=1
            bindings={binding['id']:graph_data(binding) for binding in opts.get('bindings',[])[:8]}
            output={'variables':variables,'frames':visible_frames,'frame':selected,'location':location,'watches':watches,'warnings':[],'bindingData':bindings,'monitoredBytes':state['bytes'],'elapsedMs':round((time.perf_counter()-started)*1000,2)}
        except Exception as error:output={'error':str(error)}
        gdb.write('CPPIDE_JSON:'+base64.b64encode(json.dumps(output,ensure_ascii=False).encode('utf-8')).decode('ascii')+'\n')

CppIdeSnapshot()
