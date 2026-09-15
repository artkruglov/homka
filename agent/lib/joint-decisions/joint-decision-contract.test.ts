/** Explicit consent cannot be inferred from authorship, silence, or duplicate answers. */
import { describe,expect,it } from "vitest";
import { decisionInput,decisionStatus } from "./joint-decision-contract.js";
const id="00000000-0000-4000-8000-000000000001";
describe("joint decision contract",()=>{
  it("requires two separate explicit agreements",()=>{
    expect(decisionStatus(["one","two"],[],false)).toBe("open");
    expect(decisionStatus(["one","two"],[{actor:"one",choice:"agree"}],false)).toBe("open");
    expect(decisionStatus(["one","two"],[{actor:"one",choice:"agree"},{actor:"two",choice:"agree"}],false)).toBe("agreed");
    expect(decisionStatus(["one","two"],[{actor:"one",choice:"agree"},{actor:"two",choice:"decline"}],false)).toBe("declined");
    expect(decisionStatus(["one","two"],[{actor:"one",choice:"agree"},{actor:"two",choice:"agree"}],true)).toBe("cancelled");
  });
  it("rejects duplicate, foreign and malformed participants and answers",()=>{
    expect(()=>decisionStatus(["one","one"],[],false)).toThrow(/AGENT_DECISION_STATE_INVALID/);
    expect(()=>decisionStatus(["one","two"],[{actor:"one",choice:"agree"},{actor:"one",choice:"agree"}],false)).toThrow(/AGENT_DECISION_STATE_INVALID/);
    expect(()=>decisionStatus(["one","two"],[{actor:"third",choice:"agree"}],false)).toThrow(/AGENT_DECISION_STATE_INVALID/);
    expect(()=>decisionStatus(["one","two"],[{actor:"one",choice:"maybe"}] as never,false)).toThrow(/AGENT_DECISION_STATE_INVALID/);
  });
  it("keeps identity, routing, and somebody else's answer out of model input",()=>{
    expect(decisionInput.safeParse({action:"create",partnerRef:id,title:"Воскресенье в парке"}).success).toBe(true);
    expect(decisionInput.safeParse({action:"answer",id,version:1,choice:"agree"}).success).toBe(true);
    for(const field of ["userId","actor","familyId","spaceId","telegramChatId","answers","status"]){
      expect(decisionInput.safeParse({action:"answer",id,version:1,choice:"agree",[field]:"spoof"}).success).toBe(false);
    }
    expect(decisionInput.safeParse({action:"create",partnerRef:id,title:"Парк",choice:"agree"}).success).toBe(false);
    expect(decisionInput.safeParse({action:"answer",id,choice:"agree"}).success).toBe(false);
    expect(decisionInput.safeParse({action:"answer",id,version:1,choice:"agree",title:"Изменить предложение"}).success).toBe(false);
  });
  it("requires volunteered text for feedback, without scores or statements for others",()=>{
    expect(decisionInput.safeParse({action:"feedback",id,version:1,text:"Мне понравилось, но устала"}).success).toBe(true);
    expect(decisionInput.safeParse({action:"feedback",id,version:1,text:" "}).success).toBe(false);
    expect(decisionInput.safeParse({action:"feedback",id,version:1,text:"Хорошо",rating:5}).success).toBe(false);
    expect(decisionInput.safeParse({action:"withdraw_feedback",id,version:1}).success).toBe(true);
    expect(decisionInput.safeParse({action:"get",id,version:1}).success).toBe(false);
  });
});
