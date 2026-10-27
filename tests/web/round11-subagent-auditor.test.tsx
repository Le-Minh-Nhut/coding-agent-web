// @vitest-environment jsdom
import React from "react";
import {afterEach,it,expect,vi} from "vitest";
import {act,cleanup,fireEvent,render} from "@testing-library/react";
import {SubagentPanel} from "../../apps/web/src/components/SubagentPanel.js";
afterEach(()=>{cleanup();vi.useRealTimers();});
function fixture(){
 const agent={id:"a",displayName:"Worker",kind:"sub" as const,parentId:"main",status:"running" as const,hasSessionFile:true,createdAt:0,lastActivity:0};
 return {agents:[agent],onFetchTranscript:vi.fn(),onWatchAgent:vi.fn(),transcripts:{a:{text:"first\n",newSize:6,carry:""}},transcriptErrors:{} as Record<string,string>,loadingAgentIds:[],onClose:vi.fn()};
}
it("audit11 control: running transcript keeps polling",async()=>{
 vi.useFakeTimers();const props=fixture();const view=render(<SubagentPanel {...props}/>);
 fireEvent.click(view.getByRole("button",{name:/Worker/}));
 await act(async()=>{await vi.advanceTimersByTimeAsync(2400);});
 expect(props.onFetchTranscript.mock.calls.length).toBeGreaterThanOrEqual(3);
});
it("audit11: successful refresh resumes polling after a transient transcript error",async()=>{
 vi.useFakeTimers();const props=fixture();const view=render(<SubagentPanel {...props}/>);
 fireEvent.click(view.getByRole("button",{name:/Worker/}));
 view.rerender(<SubagentPanel {...props} transcriptErrors={{a:"Network timeout"}}/>);
 await act(async()=>{await vi.advanceTimersByTimeAsync(1200);});
 fireEvent.click(view.getByRole("button",{name:"Refresh"}));
 view.rerender(<SubagentPanel {...props} transcripts={{a:{text:"recovered\n",newSize:10,carry:""}}} transcriptErrors={{}}/>);
 const before=props.onFetchTranscript.mock.calls.length;
 await act(async()=>{await vi.advanceTimersByTimeAsync(2400);});
 console.log("AUDIT11 transcript polling",JSON.stringify({before,after:props.onFetchTranscript.mock.calls.length,errorVisible:!!view.queryByRole("alert")}));
 expect(props.onFetchTranscript.mock.calls.length).toBeGreaterThan(before);
});
